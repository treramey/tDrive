import { spawnSync } from 'node:child_process';
import {
	existsSync,
	globSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { matchesGlob } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const lanes = {
	app: {
		packages: ['apps/web', 'apps/site'],
		versionPath: 'package.json',
		prefix: 'v',
		inputs: [
			'apps/web/',
			'apps/site/',
			'packages/shared/',
			'scripts/release.sh',
			'.github/workflows/app-release.yml',
			'scripts/check-wrangler-drift.mjs'
		]
	},
	cli: {
		packages: ['packages/cli', 'packages/shared'],
		versionPath: 'packages/cli/package.json',
		prefix: 'cli-v',
		inputs: [
			'packages/cli/',
			'packages/shared/',
			'scripts/install-cli.sh',
			'.github/workflows/cli-release.yml'
		]
	}
};

const packagePaths = Object.values(lanes).flatMap((lane) => lane.packages);
const packageName = (path) => `@tdrive/${path.split('/').at(-1)}`;

const notePath = (path) =>
	/^\.changeset\/[^/]+\.md$/.test(path) && path !== '.changeset/README.md';

const changelogPath = (path) => `${path}/CHANGELOG.md`;

function run(command, args, allowFailure = false) {
	const result = spawnSync(command, args, { encoding: 'utf8' });

	if (result.error) throw result.error;

	if (result.status !== 0 && !allowFailure) {
		throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr}`);
	}

	return result;
}

function git(...args) {
	return run('git', args).stdout.trim();
}

function newer(left, right) {
	const a = left.split('.').map(BigInt);
	const b = right.split('.').map(BigInt);

	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return a[i] > b[i];
	}

	return false;
}

function readState(read, paths) {
	const root = JSON.parse(read('package.json'));
	const patterns = root.workspaces.map((path) => `${path}/package.json`);

	const manifests = paths.filter((path) =>
		patterns.some((pattern) => matchesGlob(path, pattern))
	);

	if (
		manifests.length !== packagePaths.length ||
		!stableVersion.test(root.version) ||
		root.private !== true
	) {
		throw new Error(
			'Expected a private root and exactly the registered workspaces.'
		);
	}

	const state = { rootVersion: root.version };

	for (const [name, lane] of Object.entries(lanes)) {
		const packages = lane.packages.map((path) => ({
			path: `${path}/package.json`,
			...JSON.parse(read(`${path}/package.json`))
		}));

		const version = packages[0].version;

		if (
			!stableVersion.test(version) ||
			packages.some(
				(pkg, i) =>
					!manifests.includes(pkg.path) ||
					pkg.private !== true ||
					pkg.name !== packageName(lane.packages[i]) ||
					pkg.version !== version
			)
		) {
			throw new Error(
				`The ${name} lane must share one stable version across its private packages.`
			);
		}

		state[name] = { version, packages };
	}

	if (state.rootVersion !== state.app.version)
		throw new Error('Root and app lane versions disagree.');

	return state;
}

function snapshot(ref) {
	const paths = git('ls-tree', '-r', '--name-only', ref).split('\n');
	const read = (path) => run('git', ['show', `${ref}:${path}`]).stdout;

	return { ...readState(read, paths), paths, read };
}

function validateConfig() {
	const config = JSON.parse(readFileSync('.changeset/config.json', 'utf8'));

	if (
		!isDeepStrictEqual(config.fixed, [lanes.cli.packages.map(packageName)]) ||
		!isDeepStrictEqual(config.ignore, lanes.app.packages.map(packageName)) ||
		config.commit !== false ||
		config.baseBranch !== 'main' ||
		config.privatePackages?.version !== true ||
		config.privatePackages?.tag !== false ||
		config.linked?.length !== 0
	) {
		throw new Error(
			'Changesets config must match the reviewed CLI lane and ignored app lane.'
		);
	}
}

function pendingChangesets(state) {
	return state.paths.filter(notePath).map((path) => {
		const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(
			state.read(path)
		);

		if (!match || !match[2].trim())
			throw new Error(`Invalid CLI changeset ${path}.`);

		const releases = match[1]
			.split(/\r?\n/)
			.filter((line) => line.trim())
			.map((line) => {
				const release =
					/^(?:'([^']+)'|"([^"]+)"|([^:\s]+)):\s*(patch|minor|major)\s*$/.exec(
						line
					);

				const name = release?.[1] ?? release?.[2] ?? release?.[3];

				if (
					!release ||
					!lanes.cli.packages.some((pkg) => packageName(pkg) === name)
				) {
					throw new Error(
						`${path} must name only CLI/shared packages with a patch, minor, or major bump.`
					);
				}

				return { name, type: release[4] };
			});

		if (!releases.length)
			throw new Error(`${path} needs CLI/shared release front matter.`);

		return { path, releases, body: match[2].trim() };
	});
}

function releaseIdentity(ref, lane) {
	const { version } = snapshot(ref)[lane];

	const history = git(
		'rev-list',
		'--first-parent',
		ref,
		'--',
		lanes[lane].versionPath
	).split('\n');

	let commit;
	let previousVersion;

	for (const candidate of history) {
		const candidateVersion = JSON.parse(
			git('show', `${candidate}:${lanes[lane].versionPath}`)
		).version;

		if (candidateVersion !== version) {
			previousVersion = candidateVersion;
			break;
		}

		commit = candidate;
	}

	if (!previousVersion) return null;

	if (
		!stableVersion.test(previousVersion) ||
		!newer(version, previousVersion)
	) {
		throw new Error(
			`Release ${version} must increase the previous stable version.`
		);
	}

	const release = snapshot(commit);
	const parent = snapshot(`${commit}^`);

	if (
		lane === 'cli' &&
		(release.paths.some(notePath) || !pendingChangesets(parent).length)
	) {
		throw new Error(
			'CLI transition must consume pending CLI changesets and leave none at that transition.'
		);
	}

	const heading = `## ${version}`;

	for (const pkg of release[lane].packages) {
		const changelog = pkg.path.replace('package.json', 'CHANGELOG.md');

		if (
			parent[lane].version !== previousVersion ||
			!release.paths.includes(changelog) ||
			!release.read(changelog).split(/\r?\n/).includes(heading) ||
			(parent.paths.includes(changelog) &&
				parent.read(changelog).split(/\r?\n/).includes(heading))
		) {
			throw new Error(
				`Release ${version} needs a version bump and new changelog entry for ${pkg.name}.`
			);
		}
	}

	return { lane, version, commit };
}

function fetchMain() {
	git(
		'fetch',
		'--no-tags',
		'origin',
		'+refs/heads/main:refs/remotes/origin/main'
	);
}

function requireCurrentRelease(identity) {
	git('merge-base', '--is-ancestor', identity.commit, 'origin/main');
	const latest = releaseIdentity('origin/main', identity.lane);

	if (
		latest?.version !== identity.version ||
		latest.commit !== identity.commit
	) {
		throw new Error(
			`Release ${identity.version} is superseded or is not the current ${identity.lane} release on main.`
		);
	}
}

function remoteTarget(tag) {
	const ref = `refs/tags/${tag}`;
	const output = git('ls-remote', '--tags', 'origin', ref, `${ref}^{}`);

	const refs = new Map(
		output
			.split('\n')
			.filter(Boolean)
			.map((line) => line.split(/\s+/).reverse())
	);

	return refs.get(`${ref}^{}`) ?? refs.get(ref);
}

function localTarget(tag) {
	const ref = `refs/tags/${tag}`;
	const result = run('git', ['show-ref', '--verify', '--quiet', ref], true);

	if (result.status === 1) return undefined;

	if (result.status !== 0) throw new Error(`Cannot inspect local tag ${tag}.`);

	return git('rev-parse', `${ref}^{commit}`);
}

function requireExactTag(tag, actual, expected) {
	if (actual && actual !== expected)
		throw new Error(
			`Tag ${tag} targets ${actual}, expected ${expected}. Tags are immutable.`
		);
}

function ensureTag(identity) {
	if (!identity) return;
	requireCurrentRelease(identity);
	const name = `${lanes[identity.lane].prefix}${identity.version}`;
	const remote = remoteTarget(name);
	requireExactTag(name, remote, identity.commit);
	const local = localTarget(name);
	requireExactTag(name, local, identity.commit);

	if (remote) {
		console.log(`${name} already targets ${identity.commit}.`);

		return;
	}

	if (!local) {
		run('git', ['tag', name, identity.commit], true);

		if (localTarget(name) !== identity.commit)
			throw new Error(`Failed to create local tag ${name}.`);
	}

	const pushed = run(
		'git',
		['push', 'origin', `refs/tags/${name}:refs/tags/${name}`],
		true
	);

	const actual = remoteTarget(name);
	requireExactTag(name, actual, identity.commit);

	if (actual !== identity.commit)
		throw new Error(`Failed to push ${name}.\n${pushed.stderr}`);
	console.log(`${name} targets ${identity.commit}.`);
}

function parseLock(text) {
	return JSON.parse(
		text.replace(
			/("(?:\\.|[^"\\])*")|,\s*(?=[}\]])/g,
			(match, string) => string ?? ''
		)
	);
}

function withoutVersion(value) {
	const { version: _version, ...rest } = value;

	return rest;
}

function lockDependencies(text) {
	const lock = parseLock(text);

	for (const path of ['', ...packagePaths]) {
		if (lock.workspaces?.[path]) delete lock.workspaces[path].version;
	}

	return lock;
}

function ownedPath(path, lane) {
	return (
		path === 'bun.lock' ||
		(lane === 'app' && path === 'package.json') ||
		lanes[lane].packages.some(
			(pkg) => path === `${pkg}/package.json` || path === changelogPath(pkg)
		) ||
		(lane === 'cli' && notePath(path))
	);
}

function changedPaths(base, head) {
	return git('diff', '--no-renames', '--name-only', base, head)
		.split('\n')
		.filter(Boolean);
}

function impactAt(commit) {
	const base = `${commit}^`;
	const paths = changedPaths(base, commit);
	const before = (path) => run('git', ['show', `${base}:${path}`], true);
	const after = (path) => run('git', ['show', `${commit}:${path}`], true);

	const manifestMetadata = (path) => {
		try {
			return isDeepStrictEqual(
				withoutVersion(JSON.parse(before(path).stdout)),
				withoutVersion(JSON.parse(after(path).stdout))
			);
		} catch {
			return false;
		}
	};

	if (
		paths.every((path) => ownedPath(path, 'cli')) &&
		paths.includes(lanes.cli.versionPath) &&
		paths
			.filter((path) => path.endsWith('/package.json'))
			.every(manifestMetadata)
	) {
		const identity = releaseIdentity(commit, 'cli');

		if (identity?.commit === commit) return new Set();
	}

	const impact = new Set();

	for (const path of paths) {
		if (
			notePath(path) ||
			packagePaths.some((pkg) => path === changelogPath(pkg)) ||
			path === '.changeset/README.md'
		)
			continue;

		if (
			(path === 'package.json' ||
				packagePaths.some((pkg) => path === `${pkg}/package.json`)) &&
			manifestMetadata(path)
		)
			continue;

		if (path === 'bun.lock') {
			try {
				if (
					isDeepStrictEqual(
						lockDependencies(before(path).stdout),
						lockDependencies(after(path).stdout)
					)
				)
					continue;
			} catch {}
		}

		for (const [name, lane] of Object.entries(lanes)) {
			if (
				lane.inputs.some((input) =>
					input.endsWith('/') ? path.startsWith(input) : path === input
				)
			)
				impact.add(name);
		}

		if (
			path === 'package.json' ||
			path === 'bun.lock' ||
			path === '.changeset/config.json' ||
			path === '.github/workflows/changesets.yml' ||
			/^(?:vite\.config\.|tsconfig\.|\.npmrc$|\.bunfig|bunfig\.)/.test(path) ||
			(path.startsWith('scripts/') &&
				path !== 'scripts/install-cli.sh' &&
				!lanes.app.inputs.includes(path))
		) {
			impact.add('app');
			impact.add('cli');
		}
	}

	return impact;
}

function pushBase(ref) {
	const from = process.env.APP_RELEASE_FROM;

	if (!from || /^0+$/.test(from)) return null;

	if (!/^[a-f0-9]{40}$/.test(from))
		throw new Error('APP_RELEASE_FROM must be a full commit SHA.');
	git('merge-base', '--is-ancestor', from, ref);

	return from;
}

function rangeCommits(ref, lane) {
	const identity = releaseIdentity(ref, lane);
	const from = pushBase(ref);

	const base =
		identity?.commit ??
		(lane === 'cli'
			? git('rev-list', '--first-parent', '--max-parents=0', ref)
			: from);

	if (!base) return [];

	return git('rev-list', '--first-parent', '--reverse', `${base}..${ref}`)
		.split('\n')
		.filter(Boolean);
}

function assertCliCovered(ref) {
	const notes = pendingChangesets(snapshot(ref));
	const commits = rangeCommits(ref, 'cli');

	const lastConsumerChange = commits.findLastIndex((commit) =>
		impactAt(commit).has('cli')
	);

	if (lastConsumerChange === -1) return;

	const changedNotes = new Set(
		commits
			.slice(lastConsumerChange)
			.flatMap((commit) => changedPaths(`${commit}^`, commit).filter(notePath))
	);

	if (!notes.some((note) => changedNotes.has(note.path))) {
		throw new Error(
			'CLI lane refused. Consumer changes need a CLI/shared changeset added or updated with or after the latest consumer change. Eligible app releases have already completed.'
		);
	}
}

function planAppRelease(ref) {
	const commits = rangeCommits(ref, 'app').filter((commit) =>
		impactAt(commit).has('app')
	);

	if (!commits.length) return null;
	const state = snapshot(ref);
	const parts = state.app.version.split('.');
	parts[2] = String(BigInt(parts[2]) + 1n);

	return {
		version: parts.join('.'),
		previousVersion: state.app.version,
		notes: commits.map(
			(commit) =>
				`- ${git('show', '-s', '--format=%s', commit)} (${commit.slice(0, 7)})`
		)
	};
}

function writeAppPlan(plan) {
	for (const path of [
		'package.json',
		...lanes.app.packages.map((pkg) => `${pkg}/package.json`)
	]) {
		const pkg = JSON.parse(readFileSync(path, 'utf8'));
		writeFileSync(
			path,
			`${JSON.stringify({ ...pkg, version: plan.version }, null, '\t')}\n`
		);
	}

	for (const pkg of lanes.app.packages) {
		const path = changelogPath(pkg);

		const old = existsSync(path)
			? readFileSync(path, 'utf8')
			: `# ${packageName(pkg)}\n`;

		const heading = /^# [^\n]+\n/.exec(old);

		if (!heading) throw new Error(`Expected a package heading in ${path}.`);
		writeFileSync(
			path,
			`${heading[0]}\n## ${plan.version}\n\n${plan.notes.join('\n')}\n\n${old.slice(heading[0].length).trimStart()}`.trimEnd() +
				'\n'
		);
	}

	const original = readFileSync('bun.lock', 'utf8');
	const expected = parseLock(original);
	let lock = original;

	for (const path of lanes.app.packages) {
		if (
			expected.workspaces[path]?.version !== plan.previousVersion ||
			expected.workspaces[path]?.name !== packageName(path)
		)
			throw new Error(`Unexpected Bun workspace metadata for ${path}.`);

		const pattern = new RegExp(
			`(^[ \\t]*"${path}": \\{\\r?\\n[ \\t]*"name": "${packageName(path)}",\\r?\\n[ \\t]*"version": ")${plan.previousVersion.replaceAll('.', '\\.')}(")`,
			'gm'
		);

		if ([...lock.matchAll(pattern)].length !== 1)
			throw new Error(`Cannot update exact Bun workspace version for ${path}.`);
		lock = lock.replace(
			pattern,
			(_, prefix, suffix) => `${prefix}${plan.version}${suffix}`
		);
		expected.workspaces[path].version = plan.version;
	}

	if (!isDeepStrictEqual(parseLock(lock), expected))
		throw new Error('App lock update changed dependency resolutions.');
	writeFileSync('bun.lock', lock);
	run('bun', [
		'run',
		'vp',
		'fmt',
		'--write',
		'package.json',
		...lanes.app.packages.flatMap((path) => [
			`${path}/package.json`,
			changelogPath(path)
		])
	]);
}

function assertOwned(lane) {
	const paths = git('status', '--porcelain', '--untracked-files=all')
		.split('\n')
		.filter(Boolean)
		.map((line) => line.trimStart().slice(2).trim());

	if (paths.some((path) => !ownedPath(path, lane)))
		throw new Error(
			`Unexpected files changed during ${lane} version preparation.`
		);
}

function prepare() {
	if (git('status', '--porcelain'))
		throw new Error('Release preparation requires a clean worktree.');

	for (let attempt = 0; attempt < 3; attempt++) {
		fetchMain();
		git('checkout', '--detach', 'origin/main');
		const plan = planAppRelease('HEAD');

		if (plan) {
			writeAppPlan(plan);
			assertOwned('app');
			git(
				'add',
				'--',
				'package.json',
				'bun.lock',
				...lanes.app.packages.flatMap((path) => [
					`${path}/package.json`,
					changelogPath(path)
				])
			);
			git('commit', '-m', 'chore: release app');

			const pushed = run(
				'git',
				['push', 'origin', 'HEAD:refs/heads/main'],
				true
			);

			if (pushed.status !== 0) {
				const local = git('rev-parse', 'HEAD');
				fetchMain();

				if (
					run(
						'git',
						['merge-base', '--is-ancestor', local, 'origin/main'],
						true
					).status !== 0
				) {
					git('reset', '--hard', 'origin/main');

					if (attempt === 2)
						throw new Error(
							`Failed to push app release after three plans.\n${pushed.stderr}`
						);
					continue;
				}
			}

			fetchMain();
			git('checkout', '--detach', 'origin/main');
		} else {
			console.log('No personal-site changes.');
		}

		ensureTag(releaseIdentity('HEAD', 'app'));
		ensureTag(releaseIdentity('HEAD', 'cli'));
		assertCliCovered('HEAD');

		return;
	}
}

function cliVersion() {
	assertOwned('cli');
	fetchMain();
	git('reset', '--hard', 'origin/main');
	const before = snapshot('HEAD');

	for (const path of lanes.cli.packages.map(changelogPath)) {
		if (!before.paths.includes(path)) rmSync(path, { force: true });
	}

	assertCliCovered('HEAD');

	if (!pendingChangesets(before).length) {
		console.log('No pending CLI changesets.');

		return;
	}

	run('bun', ['run', 'changeset', 'version']);

	const state = readState(
		(path) => readFileSync(path, 'utf8'),
		globSync('**/package.json', { exclude: ['node_modules/**'] })
	);

	for (const path of [
		'package.json',
		...lanes.app.packages.flatMap((pkg) => [
			`${pkg}/package.json`,
			changelogPath(pkg)
		])
	]) {
		if (
			before.paths.includes(path) &&
			readFileSync(path, 'utf8') !== before.read(path)
		)
			throw new Error(`CLI preparation changed app metadata in ${path}.`);
	}

	if (state.rootVersion !== before.rootVersion)
		throw new Error('CLI preparation changed the app version.');
	rmSync('bun.lock');
	run('bun', ['install', '--lockfile-only']);
	const lock = parseLock(readFileSync('bun.lock', 'utf8'));

	for (const [name, lane] of Object.entries(lanes)) {
		for (const path of lane.packages) {
			if (lock.workspaces[path]?.version !== state[name].version)
				throw new Error(`Regenerated lock has a stale version for ${path}.`);
		}
	}

	run('bun', [
		'run',
		'vp',
		'fmt',
		'--write',
		...lanes.cli.packages.flatMap((path) => [
			`${path}/package.json`,
			changelogPath(path)
		])
	]);
	assertOwned('cli');
	console.log(`Prepared reviewed CLI release ${state.cli.version}.`);
}

function cliTag() {
	fetchMain();
	const identity = releaseIdentity('HEAD', 'cli');

	if (!identity) {
		console.log('No approved CLI version transition.');

		return;
	}

	ensureTag(identity);
}

function verifyTag(name, lane) {
	const prefix = lanes[lane].prefix;

	if (
		!name?.startsWith(prefix) ||
		!stableVersion.test(name.slice(prefix.length))
	)
		throw new Error(
			`Expected a canonical ${lane} tag ${prefix}MAJOR.MINOR.PATCH.`
		);
	const identity = releaseIdentity('HEAD', lane);

	if (
		!identity ||
		identity.version !== name.slice(prefix.length) ||
		identity.commit !== git('rev-parse', 'HEAD')
	)
		throw new Error(
			`${name} must check out its release version transition commit.`
		);
	fetchMain();
	requireCurrentRelease(identity);

	if (
		remoteTarget(name) !== identity.commit ||
		localTarget(name) !== identity.commit
	)
		throw new Error(
			`${name} must target the release commit locally and on origin.`
		);
	console.log(`Verified ${name} at ${identity.commit}.`);
}

try {
	const [command, name = process.env.GITHUB_REF_NAME, ...extra] =
		process.argv.slice(2);

	const usage =
		'Usage: app-release.mjs prepare | cli-version | cli-tag | verify-tag [vVERSION] | verify-cli-tag [cli-vVERSION]';

	if (
		extra.length ||
		(!['verify-tag', 'verify-cli-tag'].includes(command) &&
			process.argv.length > 3)
	)
		throw new Error(usage);
	validateConfig();

	switch (command) {
		case 'prepare':
			prepare();
			break;
		case 'cli-version':
			cliVersion();
			break;
		case 'cli-tag':
			cliTag();
			break;
		case 'verify-tag':
			verifyTag(name, 'app');
			break;
		case 'verify-cli-tag':
			verifyTag(name, 'cli');
			break;
		default:
			throw new Error(usage);
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
