import { spawnSync } from 'node:child_process';
import { globSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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

function workspaceState(read, paths) {
	const root = JSON.parse(read('package.json'));
	const patterns = root.workspaces.map((path) => `${path}/package.json`);

	const packages = paths
		.filter((path) => patterns.some((pattern) => matchesGlob(path, pattern)))
		.map((path) => ({ path, ...JSON.parse(read(path)) }));

	const version = packages[0]?.version;

	if (
		!stableVersion.test(version) ||
		packages.some(
			(pkg) =>
				!pkg.name.startsWith('@tdrive/') ||
				pkg.private !== true ||
				pkg.version !== version
		)
	) {
		throw new Error(
			'All private @tdrive workspaces must share one stable version.'
		);
	}

	return { root, packages, version };
}

function snapshot(ref) {
	const paths = git('ls-tree', '-r', '--name-only', ref).split('\n');
	const read = (path) => git('show', `${ref}:${path}`);
	const state = workspaceState(read, paths);

	if (state.root.version !== state.version) {
		throw new Error(`Root and workspace versions disagree at ${ref}.`);
	}

	return { ...state, paths, read };
}

function hasNotes(paths) {
	return paths.some(
		(path) =>
			/^\.changeset\/[^/]+\.md$/.test(path) && path !== '.changeset/README.md'
	);
}

function releaseIdentity(ref) {
	const { version } = snapshot(ref);

	const history = git(
		'rev-list',
		'--first-parent',
		ref,
		'--',
		'package.json'
	).split('\n');

	let commit;
	let previousVersion;

	for (const candidate of history) {
		const candidateVersion = JSON.parse(
			git('show', `${candidate}:package.json`)
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

	if (hasNotes(release.paths))
		throw new Error('Release commit still has pending changesets.');
	const heading = `## ${version}`;

	for (const pkg of release.packages) {
		const changelog = pkg.path.replace('package.json', 'CHANGELOG.md');

		if (
			!parent.packages.some(
				(old) => old.name === pkg.name && old.version === previousVersion
			) ||
			!release.paths.includes(changelog) ||
			!release.read(changelog).split('\n').includes(heading) ||
			(parent.paths.includes(changelog) &&
				parent.read(changelog).split('\n').includes(heading))
		) {
			throw new Error(
				`Release ${version} needs a version bump and new changelog entry for ${pkg.name}.`
			);
		}
	}

	return { version, commit };
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
	const latest = releaseIdentity('origin/main');

	if (
		latest?.version !== identity.version ||
		latest.commit !== identity.commit
	) {
		throw new Error(
			`Release ${identity.version} is superseded or is not the current release on main.`
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
	if (actual && actual !== expected) {
		throw new Error(
			`Tag ${tag} targets ${actual}, expected ${expected}. Tags are immutable.`
		);
	}
}

function version() {
	if (!hasNotes(globSync('.changeset/*.md'))) {
		console.log('No pending changesets.');

		return;
	}

	run('bun', ['run', 'changeset', 'version']);
	const root = JSON.parse(readFileSync('package.json', 'utf8'));
	const paths = globSync(root.workspaces.map((path) => `${path}/package.json`));
	const state = workspaceState((path) => readFileSync(path, 'utf8'), paths);
	state.root.version = state.version;
	writeFileSync('package.json', `${JSON.stringify(state.root, null, '\t')}\n`);
	// Bun 1.4.0 keeps stale workspace versions when it reuses an existing lockfile.
	rmSync('bun.lock', { force: true });
	run('bun', ['install', '--lockfile-only']);
	run('bun', [
		'run',
		'vp',
		'fmt',
		'--write',
		'package.json',
		...state.packages.flatMap((pkg) => [
			pkg.path,
			pkg.path.replace('package.json', 'CHANGELOG.md')
		])
	]);
	console.log(`Prepared application release ${state.version}.`);
}

function tag() {
	if (hasNotes(snapshot('HEAD').paths)) {
		console.log('Pending changesets need a reviewed release PR.');

		return;
	}

	const identity = releaseIdentity('HEAD');

	if (!identity) {
		console.log('No release version transition.');

		return;
	}

	fetchMain();
	requireCurrentRelease(identity);
	const name = `v${identity.version}`;
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
		requireExactTag(name, localTarget(name), identity.commit);
	}

	const pushed = run(
		'git',
		['push', 'origin', `refs/tags/${name}:refs/tags/${name}`],
		true
	);

	const actual = remoteTarget(name);
	requireExactTag(name, actual, identity.commit);

	if (actual !== identity.commit) {
		throw new Error(`Failed to push ${name}.\n${pushed.stderr}`);
	}

	console.log(`${name} targets ${identity.commit}.`);
}

function verifyTag(name) {
	if (!name?.startsWith('v') || !stableVersion.test(name.slice(1))) {
		throw new Error('Expected a canonical application tag vMAJOR.MINOR.PATCH.');
	}

	const identity = releaseIdentity('HEAD');

	if (
		!identity ||
		identity.version !== name.slice(1) ||
		identity.commit !== git('rev-parse', 'HEAD')
	) {
		throw new Error(
			`${name} must check out its release version transition commit.`
		);
	}

	fetchMain();
	requireCurrentRelease(identity);

	if (
		remoteTarget(name) !== identity.commit ||
		localTarget(name) !== identity.commit
	) {
		throw new Error(
			`${name} must target the release commit locally and on origin.`
		);
	}

	console.log(`Verified ${name} at ${identity.commit}.`);
}

try {
	const [command, name = process.env.GITHUB_REF_NAME, ...extra] =
		process.argv.slice(2);

	if (extra.length || (command !== 'verify-tag' && process.argv.length > 3)) {
		throw new Error(
			'Usage: app-release.mjs version | tag | verify-tag [vVERSION]'
		);
	}

	switch (command) {
		case 'version':
			version();
			break;
		case 'tag':
			tag();
			break;
		case 'verify-tag':
			verifyTag(name);
			break;
		default:
			throw new Error(
				'Usage: app-release.mjs version | tag | verify-tag [vVERSION]'
			);
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
