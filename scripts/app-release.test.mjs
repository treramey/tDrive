import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const project = fileURLToPath(new URL('../', import.meta.url));
const script = join(project, 'scripts/app-release.mjs');
const packages = ['apps/web', 'apps/site', 'packages/cli', 'packages/shared'];
const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();

const lanePackages = (lane) =>
	lane === 'app' ? packages.slice(0, 2) : packages.slice(2);

const tagName = (lane, version = '0.1.1') =>
	`${lane === 'app' ? 'v' : 'cli-v'}${version}`;

const verifyCommand = (lane) =>
	lane === 'app' ? 'verify-tag' : 'verify-cli-tag';

const note = (pkg = 'cli', bump = 'patch', body = 'Update CLI consumers.') =>
	`---\n'@tdrive/${pkg}': ${bump}\n---\n\n${body}\n`;

const parseLock = (text) =>
	JSON.parse(
		text.replace(
			/("(?:\\.|[^"\\])*")|,\s*(?=[}\]])/g,
			(match, string) => string ?? ''
		)
	);

function execute(cwd, command, args, env = {}) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, ...env }
	});

	if (result.error) throw result.error;

	return { ...result, output: `${result.stdout}${result.stderr}` };
}

function ok(result) {
	assert.equal(result.status, 0, result.output);

	return result.stdout.trim();
}

function fixture(t, { pending = false } = {}) {
	const base = mkdtempSync(join(tmpdir(), 'tdrive-release-'));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const repo = join(base, 'repo');
	const remote = join(base, 'origin.git');
	mkdirSync(repo);

	const write = (path, value) => {
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		writeFileSync(join(repo, path), value);
	};

	const json = (path, value) =>
		write(path, `${JSON.stringify(value, null, '\t')}\n`);

	const text = (path) => readFileSync(join(repo, path), 'utf8');
	const read = (path) => JSON.parse(text(path));
	const git = (...args) => ok(execute(repo, realGit, args));
	ok(execute(base, realGit, ['init', '--bare', remote]));
	git('init', '-b', 'main');
	git('config', 'user.name', 'Release fixture');
	git('config', 'user.email', 'release@example.invalid');
	git('remote', 'add', 'origin', remote);

	const actual = JSON.parse(
		readFileSync(join(project, 'package.json'), 'utf8')
	);

	json('package.json', {
		name: 'tdrive',
		version: '0.1.0',
		private: true,
		packageManager: 'bun@1.4.0',
		workspaces: actual.workspaces,
		scripts: { changeset: 'changeset' },
		devDependencies: {
			'@changesets/cli': actual.devDependencies['@changesets/cli'],
			'vite-plus': actual.devDependencies['vite-plus']
		}
	});

	for (const path of packages) {
		const pkg = {
			name: `@tdrive/${path.split('/').at(-1)}`,
			version: '0.1.0',
			private: true
		};

		if (path === 'apps/web' || path === 'packages/cli')
			pkg.dependencies = { '@tdrive/shared': 'workspace:^' };
		json(`${path}/package.json`, pkg);
	}

	write('.gitignore', 'node_modules/\n');
	copyFileSync(join(project, 'vite.config.ts'), join(repo, 'vite.config.ts'));
	mkdirSync(join(repo, '.changeset'));
	copyFileSync(
		join(project, '.changeset/config.json'),
		join(repo, '.changeset/config.json')
	);

	if (pending) write('.changeset/existing.md', note());
	ok(execute(repo, 'bun', ['install', '--ignore-scripts']));

	const commit = (message) => {
		git('add', '.');
		git('commit', '-m', message);

		return git('rev-parse', 'HEAD');
	};

	const push = () => git('push', 'origin', 'HEAD:refs/heads/main');

	const initial = commit(
		'Install release tooling without a version transition'
	);

	push();

	const app = (args, env) =>
		execute(repo, process.execPath, [script, ...args], {
			APP_RELEASE_FROM: '',
			...env
		});

	const remoteTag = (tag = 'v0.1.1') =>
		git(
			'ls-remote',
			'--tags',
			'origin',
			`refs/tags/${tag}`,
			`refs/tags/${tag}^{}`
		);

	const prepare = (from = initial, env = {}) =>
		app(['prepare'], { APP_RELEASE_FROM: from, ...env });

	const release = (
		lane = 'app',
		version = '0.1.1',
		{ evidence = true } = {}
	) => {
		if (lane === 'cli' && evidence && !git('ls-files', '.changeset/*.md')) {
			write('.changeset/reviewed.md', note());
			commit('Request reviewed CLI release');
		}

		if (lane === 'app')
			json('package.json', { ...read('package.json'), version });
		let lock = text('bun.lock');

		for (const path of lanePackages(lane)) {
			json(`${path}/package.json`, {
				...read(`${path}/package.json`),
				version
			});
			write(
				`${path}/CHANGELOG.md`,
				`# @tdrive/${path.split('/').at(-1)}\n\n## ${version}\n\n- Reviewed release.\n`
			);

			const pattern = new RegExp(
				`("${path}": \\{\\n      "name": "[^"\\n]+",\\n      "version": ")[^"]+(")`
			);

			lock = lock.replace(
				pattern,
				(_, prefix, suffix) => `${prefix}${version}${suffix}`
			);
		}

		write('bun.lock', lock);

		if (lane === 'cli') {
			for (const path of git('ls-files', '.changeset/*.md')
				.split('\n')
				.filter(Boolean))
				rmSync(join(repo, path));
		}

		const sha = commit(`Release ${lane} ${version}`);
		push();

		return sha;
	};

	const tag = (lane, env) =>
		lane === 'app' ? app(['prepare'], env) : app(['cli-tag'], env);

	return {
		base,
		repo,
		remote,
		write,
		json,
		text,
		read,
		git,
		commit,
		push,
		initial,
		release,
		app,
		remoteTag,
		prepare,
		tag
	};
}

function interceptGit(f, body) {
	const bin = join(f.base, 'bin');
	mkdirSync(bin);
	writeFileSync(
		join(bin, 'git'),
		`#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const realGit = ${JSON.stringify(realGit)};
const remote = ${JSON.stringify(f.remote)};
${body}
const result = spawnSync(realGit, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
		{ mode: 0o755 }
	);

	return { PATH: `${bin}:${process.env.PATH}` };
}

function assertVersions(f, app, cli) {
	assert.equal(f.read('package.json').version, app);

	for (const path of lanePackages('app'))
		assert.equal(f.read(`${path}/package.json`).version, app);

	for (const path of lanePackages('cli'))
		assert.equal(f.read(`${path}/package.json`).version, cli);

	for (const path of ['apps/web', 'packages/cli'])
		assert.equal(
			f.read(`${path}/package.json`).dependencies['@tdrive/shared'],
			'workspace:^'
		);
}

test('app preparation leaves pending CLI bytes and resolutions unchanged and is repeatable', (t) => {
	const f = fixture(t, { pending: true });
	const pending = f.text('.changeset/existing.md');
	const lockBefore = f.text('bun.lock');
	f.write('apps/site/public/index.html', '<h1>Ship the site</h1>\n');
	const feature = f.commit('Refresh the landing page');
	f.push();
	ok(f.prepare());
	assertVersions(f, '0.1.1', '0.1.0');
	assert.equal(f.text('.changeset/existing.md'), pending);

	for (const path of lanePackages('app')) {
		assert.match(f.text(`${path}/CHANGELOG.md`), /^## 0\.1\.1$/m);
		assert.match(
			f.text(`${path}/CHANGELOG.md`),
			new RegExp(`Refresh the landing page \\(${feature.slice(0, 7)}\\)`)
		);
	}

	const expected = parseLock(lockBefore);
	expected.workspaces['apps/web'].version = '0.1.1';
	expected.workspaces['apps/site'].version = '0.1.1';
	assert.deepEqual(parseLock(f.text('bun.lock')), expected);
	assert.equal(
		f.text('bun.lock').replaceAll('"version": "0.1.1"', '"version": "0.1.0"'),
		lockBefore
	);
	ok(
		execute(f.repo, 'bun', ['install', '--frozen-lockfile', '--ignore-scripts'])
	);
	assert.equal(f.git('status', '--porcelain'), '');
	const release = f.git('rev-parse', 'HEAD');
	assert.doesNotMatch(
		f.git('show', '-s', '--format=%B', release),
		/\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/i
	);
	assert.match(f.remoteTag(), new RegExp(`^${release}\\s`));
	ok(f.app(['verify-tag', 'v0.1.1']));
	ok(f.prepare());
	assert.equal(f.git('rev-parse', 'HEAD'), release);
	assert.equal(f.git('status', '--porcelain'), '');
});

test('real Changesets 2.29.8 preserves app lane after the action resets to the original context SHA', (t) => {
	const f = fixture(t);
	assert.equal(
		f.read('node_modules/@changesets/cli/package.json').version,
		'2.29.8'
	);

	for (const [pkg, bump, version] of [
		['shared', 'minor', '0.2.0'],
		['cli', 'patch', '0.2.1']
	]) {
		const from = f.git('rev-parse', 'HEAD');
		f.write(`packages/${pkg}/src/change.txt`, `New ${version} source.\n`);
		f.write('.changeset/next.md', note(pkg, bump));
		const context = f.commit(`${pkg} ${bump}`);
		f.push();
		ok(f.prepare(from));
		const appVersion = f.read('package.json').version;

		const appMetadata = [
			'package.json',
			...lanePackages('app').flatMap((path) => [
				`${path}/package.json`,
				`${path}/CHANGELOG.md`
			])
		]
			.values()
			.filter((path) => f.git('ls-files', path))
			.map((path) => [path, f.text(path)])
			.toArray();

		const main = f.git('rev-parse', 'origin/main');
		f.git('checkout', '-B', 'changeset-release/main', context);
		ok(f.app(['cli-version'], { APP_RELEASE_FROM: from }));
		assert.equal(
			f.git('rev-parse', 'HEAD'),
			main,
			'release PR must include the app commit'
		);
		assertVersions(f, appVersion, version);

		for (const [path, bytes] of appMetadata) assert.equal(f.text(path), bytes);

		for (const path of lanePackages('cli'))
			assert.match(
				f.text(`${path}/CHANGELOG.md`),
				new RegExp(`^## ${version.replaceAll('.', '\\.')}\\r?$`, 'm')
			);
		const lock = f.text('bun.lock');

		for (const path of packages)
			assert.equal(
				parseLock(lock).workspaces[path].version,
				path.startsWith('apps/') ? appVersion : version
			);
		ok(
			execute(f.repo, 'bun', [
				'install',
				'--frozen-lockfile',
				'--ignore-scripts'
			])
		);
		assert.equal(f.text('bun.lock'), lock);
		f.git('add', '.');
		const diff = f.git('diff', '--binary', 'HEAD');
		ok(f.app(['cli-version'], { APP_RELEASE_FROM: from }));
		f.git('add', '.');
		assert.equal(f.git('diff', '--binary', 'HEAD'), diff);
		const release = f.commit('Reviewed CLI release');
		f.push();
		ok(f.app(['cli-tag']));
		assert.match(f.remoteTag(`cli-v${version}`), new RegExp(`^${release}\\s`));
		ok(f.app(['verify-cli-tag', `cli-v${version}`]));
		ok(f.prepare(release));
		assert.equal(
			f.git('rev-parse', 'HEAD'),
			release,
			'version output must not start another app release'
		);
	}
});

test('mixed missing-note work publishes the eligible app first and refuses only the CLI lane', (t) => {
	const f = fixture(t);
	f.write('packages/shared/src/index.ts', 'export const changed = true;\n');
	f.commit('Change shared behavior without CLI approval');
	f.push();
	const result = f.prepare();
	assert.notEqual(result.status, 0);
	assert.match(result.output, /CLI lane refused/);
	assertVersions(f, '0.1.1', '0.1.0');
	assert.notEqual(f.remoteTag(), '');
	assert.equal(f.remoteTag('cli-v0.1.1'), '');
	ok(f.app(['verify-tag', 'v0.1.1']));
	const release = f.git('rev-parse', 'HEAD');
	assert.notEqual(f.prepare().status, 0);
	assert.equal(f.git('rev-parse', 'HEAD'), release);
});

test('only CLI changes need a fresh note, including installer and build inputs', (t) => {
	for (const path of [
		'packages/cli/src/new.ts',
		'packages/cli/scripts/build.mjs',
		'scripts/install-cli.sh',
		'.github/workflows/cli-release.yml'
	]) {
		const f = fixture(t, { pending: true });
		f.write(path, 'consumer change\n');
		f.commit('Change CLI input');
		f.push();
		assert.notEqual(f.prepare().status, 0, path);
		assertVersions(f, '0.1.0', '0.1.0');
		assert.equal(f.remoteTag(), '');
		f.write(
			'.changeset/existing.md',
			note('cli', 'patch', 'Approve this consumer change.')
		);
		f.commit('Update the CLI note');
		f.push();
		ok(f.prepare());
	}
});

test('a note from an earlier push cannot approve later CLI work', (t) => {
	const f = fixture(t);
	f.release('cli');
	f.write('.changeset/future.md', note());
	const from = f.commit('Add a pending note before this push');
	f.write('packages/cli/src/new.ts', 'new work\n');
	f.commit('Later consumer work');
	f.push();
	assert.notEqual(f.prepare(from).status, 0);
	assert.notEqual(f.app(['cli-version'], { APP_RELEASE_FROM: from }).status, 0);
	const source = f.git('rev-parse', 'HEAD');
	f.write(
		'docs/later.md',
		'A later docs push cannot approve old consumer work.\n'
	);
	f.commit('Later docs push');
	f.push();
	assert.notEqual(f.prepare(source).status, 0);
	assert.notEqual(
		f.app(['cli-version'], { APP_RELEASE_FROM: source }).status,
		0
	);
});

test('deployment inputs release apps while root tooling and lock resolutions require CLI approval too', (t) => {
	for (const kind of ['deployment', 'root dependency', 'lock resolution']) {
		const f = fixture(t);

		if (kind === 'deployment')
			f.write(
				'apps/web/wrangler.jsonc',
				'{"compatibility_date":"2026-10-28"}\n'
			);

		if (kind === 'root dependency')
			f.json('package.json', {
				...f.read('package.json'),
				devDependencies: {
					...f.read('package.json').devDependencies,
					zod: '^4.4.3'
				}
			});

		if (kind === 'lock resolution') {
			const lock = f.text('bun.lock');
			assert.match(lock, /sha512-/);
			f.write('bun.lock', lock.replace('sha512-', 'sha512-reviewed-change-'));
		}

		f.commit(`Change ${kind}`);
		f.push();
		const result = f.prepare();

		if (kind === 'deployment') ok(result);
		else {
			assert.notEqual(result.status, 0);
			assert.match(result.output, /CLI lane refused/);
		}

		assertVersions(f, '0.1.1', '0.1.0');
		assert.notEqual(f.remoteTag(), '');
	}
});

test('bookkeeping, docs, and version-only lock metadata do not create release loops', (t) => {
	const f = fixture(t);
	f.release('app');
	f.release('cli');
	const from = f.git('rev-parse', 'HEAD^');
	f.write('docs/new.md', 'Documentation only.\n');
	f.commit('Document releases');
	f.push();
	const head = f.git('rev-parse', 'HEAD');
	ok(f.prepare(from));
	assert.equal(f.git('rev-parse', 'HEAD'), head);
	assertVersions(f, '0.1.1', '0.1.1');
});

test('CLI tag recovery uses the approved transition despite later notes and an app version change', (t) => {
	const f = fixture(t);
	const cli = f.release('cli', '0.2.0');
	f.write('.changeset/future.md', note());
	f.commit('Future CLI note');
	f.push();
	const app = f.release('app', '0.1.1');
	ok(f.tag('app'));
	assert.match(f.remoteTag('cli-v0.2.0'), new RegExp(`^${cli}\\s`));
	assert.match(f.remoteTag(), new RegExp(`^${app}\\s`));
	ok(f.app(['cli-tag']));
	f.git('checkout', '--detach', cli);
	ok(f.app(['verify-cli-tag', 'cli-v0.2.0']));
	f.git('checkout', '--detach', app);
	ok(f.app(['verify-tag', 'v0.1.1']));
});

test('app pushes replan from a concurrent main tip without force and keep both changes', (t) => {
	const f = fixture(t);
	f.write('apps/site/public/index.html', 'first\n');
	f.commit('First site change');
	f.push();
	const other = join(f.base, 'other');
	ok(execute(f.base, realGit, ['clone', '-b', 'main', f.remote, other]));
	ok(execute(other, realGit, ['config', 'user.name', 'Other author']));
	ok(
		execute(other, realGit, ['config', 'user.email', 'other@example.invalid'])
	);
	writeFileSync(join(other, 'apps/site/concurrent.txt'), 'second\n');
	ok(execute(other, realGit, ['add', '.']));
	ok(execute(other, realGit, ['commit', '-m', 'Concurrent site change']));

	const env = interceptGit(
		f,
		`
if (args.includes('--force') || args.includes('-f')) process.exit(99);
if (args[0] === 'push' && args.includes('HEAD:refs/heads/main') && !require('node:fs').existsSync(${JSON.stringify(join(f.base, 'raced'))})) {
  require('node:fs').writeFileSync(${JSON.stringify(join(f.base, 'raced'))}, 'yes');
  const result = spawnSync(realGit, ['-C', ${JSON.stringify(other)}, 'push', 'origin', 'main'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status);
}`
	);

	ok(f.prepare(f.initial, env));
	assertVersions(f, '0.1.1', '0.1.0');
	assert.match(f.text('apps/site/CHANGELOG.md'), /First site change/);
	assert.match(f.text('apps/site/CHANGELOG.md'), /Concurrent site change/);
	assert.equal(f.text('apps/site/concurrent.txt'), 'second\n');
});

test('lost app main-push acknowledgement converges without another version bump', (t) => {
	const f = fixture(t);
	f.write('apps/site/change.txt', 'changed\n');
	f.commit('Site change');
	f.push();

	const env = interceptGit(
		f,
		`
if (args[0] === 'push' && args.includes('HEAD:refs/heads/main')) {
  spawnSync(realGit, args, { stdio: 'inherit' });
  process.exit(128);
}`
	);

	ok(f.prepare(f.initial, env));
	assertVersions(f, '0.1.1', '0.1.0');
	const release = f.git('rev-parse', 'HEAD');
	ok(f.prepare());
	assert.equal(f.git('rev-parse', 'HEAD'), release);
});

test('invalid changeset front matter cannot authorize CLI publication and app work still completes', (t) => {
	for (const body of [
		"---\n'@tdrive/web': patch\n---\n\nWrong lane.\n",
		'---\n\n---\n\nNo packages.\n',
		note('cli', 'banana')
	]) {
		const f = fixture(t);
		f.write('packages/shared/change.txt', 'shared source\n');
		f.write('.changeset/bad.md', body);
		f.commit('Mixed work with invalid approval');
		f.push();
		assert.notEqual(f.prepare().status, 0);
		assert.notEqual(f.remoteTag(), '');
		assert.equal(f.remoteTag('cli-v0.1.1'), '');
	}
});

for (const lane of ['app', 'cli']) {
	test(`${lane} initial versions have no release identity`, (t) => {
		const f = fixture(t);
		ok(f.tag(lane));
		assert.equal(f.remoteTag(tagName(lane, '0.1.0')), '');
		assert.notEqual(
			f.app([verifyCommand(lane), tagName(lane, '0.1.0')]).status,
			0
		);
	});

	test(`${lane} transition needs a new matching changelog for every lane package`, (t) => {
		const f = fixture(t);
		f.release(lane);
		f.git('rm', `${lanePackages(lane)[1]}/CHANGELOG.md`);
		f.git('commit', '--amend', '--no-edit');
		f.git('push', '--force', 'origin', 'HEAD:refs/heads/main');
		assert.notEqual(f.tag(lane).status, 0);
		assert.equal(f.remoteTag(tagName(lane)), '');
	});

	test(`${lane} recovery finds the introducing commit after a later same-version push`, (t) => {
		const f = fixture(t);
		const release = f.release(lane);
		f.write('docs/later.md', 'Later documentation.\n');
		f.commit('Document later');
		f.push();
		ok(f.tag(lane));
		assert.match(f.remoteTag(tagName(lane)), new RegExp(`^${release}\\s`));
		ok(f.tag(lane));
		assert.notEqual(f.app([verifyCommand(lane), tagName(lane)]).status, 0);
		f.git('checkout', '--detach', release);
		ok(f.app([verifyCommand(lane), tagName(lane)]));
	});

	test(`${lane} exact annotated remote tags succeed without recreating local tags`, (t) => {
		const f = fixture(t);
		const release = f.release(lane);
		const name = tagName(lane);
		f.git('tag', '-a', name, '-m', 'Approved release', release);
		f.git('push', 'origin', `refs/tags/${name}`);
		f.git('tag', '-d', name);
		const refs = f.remoteTag(name);
		ok(f.tag(lane));
		assert.equal(f.remoteTag(name), refs);
		assert.equal(f.git('tag', '--list', name), '');
		f.git('fetch', 'origin', 'tag', name);
		ok(f.app([verifyCommand(lane), name]));
	});

	test(`${lane} interrupted local tags are pushed on retry`, (t) => {
		const f = fixture(t);
		const release = f.release(lane);
		f.git('tag', tagName(lane), release);
		ok(f.tag(lane));
		assert.match(f.remoteTag(tagName(lane)), new RegExp(`^${release}\\s`));
	});

	test(`${lane} conflicting local and remote tags are immutable`, (t) => {
		for (const remote of [false, true]) {
			const f = fixture(t);
			f.release(lane);
			const name = tagName(lane);
			f.git('tag', name, f.initial);

			if (remote) f.git('push', 'origin', `refs/tags/${name}`);
			const refs = f.remoteTag(name);
			assert.notEqual(f.tag(lane).status, 0);
			assert.equal(f.git('rev-parse', name), f.initial);
			assert.equal(f.remoteTag(name), refs);
		}
	});

	test(`${lane} remote errors are not missing tags and rejected pushes can recover`, (t) => {
		const f = fixture(t);
		const release = f.release(lane);

		const env = interceptGit(
			f,
			`
if (args[0] === process.env.FAIL_GIT_COMMAND) {
  process.stderr.write('fixture transport failure\\n');
  process.exit(128);
}`
		);

		assert.notEqual(
			f.tag(lane, { ...env, FAIL_GIT_COMMAND: 'ls-remote' }).status,
			0
		);
		assert.equal(f.git('tag', '--list'), '');
		assert.notEqual(
			f.tag(lane, { ...env, FAIL_GIT_COMMAND: 'push' }).status,
			0
		);
		assert.equal(f.remoteTag(tagName(lane)), '');
		ok(f.tag(lane));
		assert.match(f.remoteTag(tagName(lane)), new RegExp(`^${release}\\s`));
	});

	test(`${lane} tag push races reconcile exact peeled remote targets`, (t) => {
		for (const conflict of [false, true]) {
			const f = fixture(t);
			const release = f.release(lane);
			const target = conflict ? f.initial : release;
			const name = tagName(lane);

			const env = interceptGit(
				f,
				`
if (args[0] === 'push') {
  const result = spawnSync(realGit, ['-C', remote, '-c', 'user.name=Race', '-c', 'user.email=race@example.invalid', 'tag', '-a', ${JSON.stringify(name)}, ${JSON.stringify(target)}, '-m', 'Concurrent tag'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status);
}`
			);

			const result = f.tag(lane, env);

			if (conflict) assert.notEqual(result.status, 0, result.output);
			else ok(result);
			assert.match(
				f.remoteTag(name),
				new RegExp(
					`^${target}\\s+refs/tags/${name.replaceAll('.', '\\.')}\\^\\{\\}$`,
					'm'
				)
			);
		}
	});

	test(`${lane} lost tag-push acknowledgements reconcile origin`, (t) => {
		const f = fixture(t);
		f.release(lane);

		const env = interceptGit(
			f,
			`
if (args[0] === 'push') {
  spawnSync(realGit, args, { stdio: 'inherit' });
  process.exit(128);
}`
		);

		ok(f.tag(lane, env));
		ok(f.app([verifyCommand(lane), tagName(lane)]));
	});

	test(`${lane} verification rejects malformed, wrong-lane, mismatched and moved tags`, (t) => {
		const f = fixture(t);
		f.release(lane);
		ok(f.tag(lane));

		for (const name of [
			tagName(lane === 'app' ? 'cli' : 'app'),
			tagName(lane, '01.1.1'),
			tagName(lane, '0.1'),
			tagName(lane, '0.1.1-beta.1'),
			tagName(lane, '0.1.1+meta'),
			tagName(lane, '0.1.1/extra'),
			tagName(lane, '0.1.2')
		])
			assert.notEqual(f.app([verifyCommand(lane), name]).status, 0, name);
		f.git('tag', '-f', tagName(lane), f.initial);
		f.git('push', '--force', 'origin', `refs/tags/${tagName(lane)}`);
		assert.notEqual(f.app([verifyCommand(lane), tagName(lane)]).status, 0);
	});

	test(`${lane} superseded releases fail before publication`, (t) => {
		const f = fixture(t);
		const old = f.release(lane);
		ok(f.tag(lane));
		f.release(lane, '0.2.0');
		ok(f.tag(lane));
		f.git('checkout', '--detach', old);
		assert.match(
			f.app([verifyCommand(lane), tagName(lane)]).output,
			/superseded/
		);

		if (lane === 'cli') assert.notEqual(f.tag(lane).status, 0);
	});

	test(`${lane} transitions outside main ancestry cannot publish`, (t) => {
		const f = fixture(t);
		f.release(lane);
		ok(f.tag(lane));
		f.git('push', '--force', 'origin', `${f.initial}:refs/heads/main`);
		assert.notEqual(f.app([verifyCommand(lane), tagName(lane)]).status, 0);
	});
}

test('fabricated CLI bumps without consumed notes or with remaining notes cannot tag', (t) => {
	for (const kind of ['no consumed note', 'remaining note']) {
		const f = fixture(t);
		f.release('cli', '0.1.1', { evidence: kind !== 'no consumed note' });

		if (kind === 'remaining note') {
			f.write('.changeset/still-pending.md', note());
			f.git('add', '.');
			f.git('commit', '--amend', '--no-edit');
			f.git('push', '--force', 'origin', 'HEAD:refs/heads/main');
		}

		assert.notEqual(f.app(['cli-tag']).status, 0);
		assert.equal(f.remoteTag('cli-v0.1.1'), '');
	}
});

test('a reviewed CLI merge is its first-parent release identity', (t) => {
	const f = fixture(t);
	f.write('.changeset/review.md', note());
	f.commit('Request CLI release');
	f.push();
	f.git('checkout', '-b', 'changeset-release/main');
	ok(f.app(['cli-version']));
	f.commit('Prepare release PR');
	f.git('checkout', 'main');
	f.write('docs/advance.md', 'Main advanced.\n');
	f.commit('Advance main');
	f.git(
		'merge',
		'--no-ff',
		'changeset-release/main',
		'-m',
		'Merge reviewed CLI release'
	);
	f.push();
	const merge = f.git('rev-parse', 'HEAD');
	ok(f.app(['cli-tag']));
	assert.match(f.remoteTag('cli-v0.1.1'), new RegExp(`^${merge}\\s`));
	ok(f.app(['verify-cli-tag', 'cli-v0.1.1']));
});

test('lane version drift and policy drift fail before a tag is created', (t) => {
	for (const kind of ['root', 'workspace', 'config']) {
		const f = fixture(t);
		f.release();

		if (kind === 'root')
			f.json('package.json', { ...f.read('package.json'), version: '0.1.2' });

		if (kind === 'workspace')
			f.json('packages/shared/package.json', {
				...f.read('packages/shared/package.json'),
				version: '0.1.2'
			});

		if (kind === 'config')
			f.json('.changeset/config.json', {
				...f.read('.changeset/config.json'),
				fixed: [['@tdrive/*']]
			});
		f.commit(`Invalid ${kind} drift`);
		f.push();
		assert.notEqual(f.tag('app').status, 0);
		assert.equal(f.remoteTag(), '');
	}
});

test('manual dispatch has no invented initial release and rejects unsafe ranges or dirty trees', (t) => {
	const f = fixture(t);
	ok(f.app(['prepare']));
	assert.equal(f.remoteTag('v0.1.0'), '');
	assert.notEqual(
		f.app(['prepare'], { APP_RELEASE_FROM: 'not-a-sha' }).status,
		0
	);
	f.write('untracked.txt', 'Local work.\n');
	assert.notEqual(f.prepare().status, 0);
	assert.equal(f.text('untracked.txt'), 'Local work.\n');
});

function disposableDirectory(t, prefix) {
	const path = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(path, { recursive: true, force: true }));

	return path;
}

function runChild(command, args, cwd, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, ...env }
		});

		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (data) => {
			stdout += data;
		});
		child.stderr.on('data', (data) => {
			stderr += data;
		});
		child.once('error', reject);
		child.once('close', (status) =>
			resolve({ status, stdout, stderr, output: stdout + stderr })
		);
	});
}

test('the real installer discovers the new repository and verifies release-pinned bundle downloads', (t) => {
	const base = disposableDirectory(t, 'tdrive-installer-');
	const bin = join(base, 'bin');
	const install = join(base, 'installed');
	const log = join(base, 'requests.jsonl');
	const bundle = '#!/usr/bin/env node\nconsole.log("tdrive v2.0.0");\n';
	const digest = createHash('sha256').update(bundle).digest('hex');
	mkdirSync(bin);
	writeFileSync(join(base, 'tdrive.mjs'), bundle);
	writeFileSync(join(base, 'checksums.txt'), `${digest}  tdrive.mjs\n`);
	writeFileSync(
		join(base, 'releases.json'),
		JSON.stringify([
			{ tag_name: 'v99.0.0' },
			{ tag_name: 'cli-v9.0.0-rc.1' },
			{ tag_name: 'cli-v1.0.0' },
			{ tag_name: 'cli-v2.0.0' }
		])
	);
	writeFileSync(
		join(bin, 'curl'),
		`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const url = args.find((arg) => arg.startsWith('https://'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(url) + '\\n');
const files = {
  'https://api.github.com/repos/treramey/tDrive/releases?per_page=100': 'releases.json',
  'https://github.com/treramey/tDrive/releases/download/cli-v2.0.0/tdrive.mjs': 'tdrive.mjs',
  'https://github.com/treramey/tDrive/releases/download/cli-v2.0.0/checksums.txt': 'checksums.txt'
};
if (!files[url]) process.exit(90);
const bytes = fs.readFileSync(${JSON.stringify(base)} + '/' + files[url]);
const output = args.indexOf('-o');
if (output === -1) process.stdout.write(bytes);
else fs.writeFileSync(args[output + 1], bytes);
`,
		{ mode: 0o755 }
	);

	const env = {
		PATH: `${bin}:${process.env.PATH}`,
		TDRIVE_INSTALL_DIR: install,
		TDRIVE_CLI_VERSION: '',
		TDRIVE_BASE_URL: ''
	};

	ok(execute(project, 'bash', ['scripts/install-cli.sh'], env));
	assert.equal(readFileSync(join(install, 'tdrive.mjs'), 'utf8'), bundle);
	assert.equal(
		ok(execute(project, join(install, 'tdrive'), ['--version'])),
		'tdrive v2.0.0'
	);
	assert.deepEqual(
		readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse),
		[
			'https://api.github.com/repos/treramey/tDrive/releases?per_page=100',
			'https://github.com/treramey/tDrive/releases/download/cli-v2.0.0/tdrive.mjs',
			'https://github.com/treramey/tDrive/releases/download/cli-v2.0.0/checksums.txt'
		]
	);
	writeFileSync(log, '');
	ok(
		execute(project, 'bash', ['scripts/install-cli.sh'], {
			...env,
			TDRIVE_CLI_VERSION: 'cli-v2.0.0'
		})
	);
	assert.equal(
		readFileSync(log, 'utf8').includes('api.github.com'),
		false,
		'a pinned installer must not rediscover latest'
	);
	writeFileSync(join(base, 'checksums.txt'), `${'0'.repeat(64)}  tdrive.mjs\n`);

	const failed = execute(project, 'bash', ['scripts/install-cli.sh'], {
		...env,
		TDRIVE_CLI_VERSION: 'cli-v2.0.0'
	});

	assert.notEqual(failed.status, 0);
	assert.match(failed.output, /Checksum mismatch/);
	assert.equal(
		readFileSync(join(install, 'tdrive.mjs'), 'utf8'),
		bundle,
		'bad downloads must preserve the existing installation'
	);
});

test('the built upgrader uses the new repository, pins its installer and refuses bad checksums', async (t) => {
	const base = disposableDirectory(t, 'tdrive-upgrade-');
	const cliDirectory = join(project, 'packages/cli');
	ok(
		execute(cliDirectory, 'bun', ['run', 'build'], {
			TDRIVE_CLI_VERSION: '1.0.0'
		})
	);
	const bundle = join(base, 'tdrive.mjs');
	copyFileSync(join(cliDirectory, 'dist/tdrive.mjs'), bundle);
	const capture = join(base, 'upgrade.txt');

	const installer =
		'#!/usr/bin/env bash\nprintf "%s\\n" "$TDRIVE_CLI_VERSION" "$TDRIVE_INSTALL_DIR" > "$UPGRADE_CAPTURE"\n';

	const digest = createHash('sha256').update(installer).digest('hex');
	const requests = [];
	let corrupt = false;

	const server = createServer((request, response) => {
		requests.push(request.url);

		if (request.url === '/repos/treramey/tDrive/releases?per_page=100') {
			response.setHeader('Content-Type', 'application/json');
			response.end(
				JSON.stringify([
					{ tag_name: 'v99.0.0' },
					{ tag_name: 'cli-v9.0.0-rc.1' },
					{ tag_name: 'cli-v1.1.0' },
					{ tag_name: 'cli-v1.2.0' }
				])
			);
		} else if (
			request.url ===
			'/treramey/tDrive/releases/download/cli-v1.2.0/install-cli.sh'
		)
			response.end(installer);
		else if (
			request.url ===
			'/treramey/tDrive/releases/download/cli-v1.2.0/checksums.txt'
		)
			response.end(`${corrupt ? '0'.repeat(64) : digest}  install-cli.sh\n`);
		else {
			response.statusCode = 404;
			response.end('Unexpected release URL');
		}
	});

	t.after(() => new Promise((resolve) => server.close(resolve)));
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const preload = join(base, 'release-proxy.mjs');
	writeFileSync(
		preload,
		`const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const parsed = new URL(url);
  if (!['api.github.com', 'github.com'].includes(parsed.hostname)) throw new Error('Unexpected network request');
  return realFetch(${JSON.stringify(origin)} + parsed.pathname + parsed.search, options);
};\n`
	);

	const run = (args) =>
		runChild(
			process.execPath,
			['--import', preload, bundle, '--json', 'upgrade', ...args],
			base,
			{ UPGRADE_CAPTURE: capture }
		);

	const check = await run(['--check']);
	ok(check);
	assert.deepEqual(JSON.parse(check.stdout), {
		status: 'outdated',
		version: '1.0.0',
		latest: '1.2.0'
	});
	const upgrade = await run([]);
	ok(upgrade);
	assert.deepEqual(JSON.parse(upgrade.stdout), {
		status: 'upgraded',
		from: '1.0.0',
		to: '1.2.0'
	});
	assert.equal(readFileSync(capture, 'utf8'), `cli-v1.2.0\n${base}\n`);
	assert.deepEqual(requests, [
		'/repos/treramey/tDrive/releases?per_page=100',
		'/repos/treramey/tDrive/releases?per_page=100',
		'/treramey/tDrive/releases/download/cli-v1.2.0/install-cli.sh',
		'/treramey/tDrive/releases/download/cli-v1.2.0/checksums.txt'
	]);
	rmSync(capture);
	corrupt = true;
	const failed = await run([]);
	assert.notEqual(failed.status, 0);
	assert.match(failed.output, /installer checksum mismatch/);
	assert.throws(() => readFileSync(capture), { code: 'ENOENT' });
});

test('tracked release, download and install guidance has no old upstream URLs', () => {
	const paths = ok(execute(project, realGit, ['ls-files', '-z']))
		.split('\0')
		.filter(Boolean);

	const oldSlug = ['davis7dotsh', 'aDrive'].join('/');

	for (const path of paths) {
		try {
			if (!statSync(join(project, path)).isFile()) continue;

			assert.equal(
				readFileSync(join(project, path), 'utf8').includes(oldSlug),
				false,
				path
			);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
});
