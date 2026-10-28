import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const project = fileURLToPath(new URL('../', import.meta.url));
const script = join(project, 'scripts/app-release.mjs');

const packagePaths = [
	'apps/web',
	'apps/site',
	'packages/shared',
	'packages/cli'
];

const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();

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
	const base = mkdtempSync(join(tmpdir(), 'tdrive-app-release-'));
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

	const read = (path) => JSON.parse(readFileSync(join(repo, path), 'utf8'));
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
		workspaces: actual.workspaces,
		scripts: { changeset: 'changeset' },
		devDependencies: {
			'@changesets/cli': actual.devDependencies['@changesets/cli'],
			'vite-plus': actual.devDependencies['vite-plus']
		}
	});

	for (const path of packagePaths) {
		const { name } = JSON.parse(
			readFileSync(join(project, path, 'package.json'), 'utf8')
		);

		const pkg = {
			name,
			version: '0.1.0',
			private: true
		};

		if (path === 'apps/web' || path === 'packages/cli') {
			pkg.dependencies = { '@tdrive/shared': 'workspace:^' };
		}

		json(`${path}/package.json`, pkg);
	}

	write('.gitignore', 'node_modules/\n');
	copyFileSync(join(project, 'vite.config.ts'), join(repo, 'vite.config.ts'));
	mkdirSync(join(repo, '.changeset'));
	copyFileSync(
		join(project, '.changeset/config.json'),
		join(repo, '.changeset/config.json')
	);

	if (pending) {
		write(
			'.changeset/bootstrap.md',
			"---\n'@tdrive/web': patch\n---\n\nAdd reviewed application releases.\n"
		);
	}

	const commit = (message) => {
		git('add', '.');
		git('commit', '-m', message);

		return git('rev-parse', 'HEAD');
	};

	const initial = commit('Install release tooling without bumping versions');
	const push = () => git('push', 'origin', 'main');
	push();

	const release = (version = '0.1.1') => {
		json('package.json', { ...read('package.json'), version });

		for (const path of packagePaths) {
			const pkg = read(`${path}/package.json`);
			json(`${path}/package.json`, { ...pkg, version });
			write(
				`${path}/CHANGELOG.md`,
				`# ${pkg.name}\n\n## ${version}\n\n### Patch Changes\n\n- Reviewed release.\n`
			);
		}

		const sha = commit(`Release ${version}`);
		push();

		return sha;
	};

	const app = (args, env) =>
		execute(repo, process.execPath, [script, ...args], env);

	const remoteTag = (tag = 'v0.1.1') =>
		git(
			'ls-remote',
			'--tags',
			'origin',
			`refs/tags/${tag}`,
			`refs/tags/${tag}^{}`
		);

	return {
		base,
		repo,
		remote,
		write,
		json,
		read,
		git,
		commit,
		push,
		initial,
		release,
		app,
		remoteTag
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

test('real Changesets versions the fixed private group, root, changelogs, and Bun lock', (t) => {
	const f = fixture(t, { pending: true });
	ok(execute(f.repo, 'bun', ['install', '--ignore-scripts']));
	const before = f.git('rev-parse', 'HEAD');
	ok(f.app(['tag']));
	assert.equal(f.remoteTag(), '');

	for (const [name, expected, note] of [
		['bootstrap', '0.1.1', null],
		[
			'shared minor',
			'0.2.0',
			"---\n'@tdrive/shared': minor\n---\n\nChange the shared library.\n"
		],
		[
			'CLI patch',
			'0.2.1',
			"---\n'@tdrive/cli': patch\n---\n\nChange the CLI.\n"
		]
	]) {
		if (note) f.write('.changeset/next.md', note);
		ok(f.app(['version']));
		assert.equal(f.read('package.json').version, expected, name);

		for (const path of packagePaths) {
			assert.equal(f.read(`${path}/package.json`).version, expected, name);
			assert.match(
				readFileSync(join(f.repo, path, 'CHANGELOG.md'), 'utf8'),
				new RegExp(`^## ${expected.replaceAll('.', '\\.')}\\r?$`, 'm')
			);
		}

		for (const path of ['apps/web', 'packages/cli']) {
			assert.equal(
				f.read(`${path}/package.json`).dependencies['@tdrive/shared'],
				'workspace:^'
			);
		}

		const lock = readFileSync(join(f.repo, 'bun.lock'), 'utf8');
		assert.equal(
			(
				lock.match(
					new RegExp(`"version":\\s*"${expected.replaceAll('.', '\\.')}"`, 'g')
				) ?? []
			).length,
			4,
			lock.slice(0, 3000)
		);
		ok(
			execute(f.repo, 'bun', [
				'install',
				'--frozen-lockfile',
				'--ignore-scripts'
			])
		);
		assert.equal(readFileSync(join(f.repo, 'bun.lock'), 'utf8'), lock);
		ok(
			execute(f.repo, 'bun', [
				'run',
				'vp',
				'fmt',
				'--check',
				'package.json',
				...packagePaths.flatMap((path) => [
					`${path}/package.json`,
					`${path}/CHANGELOG.md`
				])
			])
		);
		f.git('add', '.');
		const diff = f.git('diff', '--binary', 'HEAD');
		ok(f.app(['version']));
		assert.equal(
			f.git('diff', '--binary', 'HEAD'),
			diff,
			'no-pending version rerun changes nothing'
		);
		const release = f.commit(name);
		f.push();
		ok(f.app(['tag']));
		assert.match(
			f.remoteTag(`v${expected}`),
			new RegExp(
				`^${release}\\s+refs/tags/v${expected.replaceAll('.', '\\.')}$`,
				'm'
			)
		);
		ok(f.app(['verify-tag', `v${expected}`]));
	}

	assert.notEqual(f.git('rev-parse', 'HEAD'), before);
});

test('initial version without release evidence never gets tagged', (t) => {
	const f = fixture(t);
	ok(f.app(['tag']));
	assert.equal(f.remoteTag('v0.1.0'), '');
	assert.notEqual(f.app(['verify-tag', 'v0.1.0']).status, 0);
});

test('version transition needs new changelog evidence for every workspace', (t) => {
	const f = fixture(t);
	f.release();
	f.git('rm', 'packages/cli/CHANGELOG.md');
	f.git('commit', '--amend', '--no-edit');
	f.git('push', '--force', 'origin', 'main');
	assert.notEqual(f.app(['tag']).status, 0);
	assert.equal(f.remoteTag(), '');
});

test('lost release run recovers the introducing commit after a later same-version main push', (t) => {
	const f = fixture(t);
	const release = f.release();
	f.json('package.json', {
		...f.read('package.json'),
		description: 'Later main change.'
	});
	f.commit('No new release');
	f.push();
	ok(f.app(['tag']));
	assert.match(f.remoteTag(), new RegExp(`^${release}\\s`));
	ok(f.app(['tag']));
	assert.notEqual(
		f.app(['verify-tag', 'v0.1.1']).status,
		0,
		'later commit is not a release identity'
	);
	f.git('checkout', '--detach', release);
	ok(f.app(['verify-tag', 'v0.1.1']));
});

test('a reviewed merge commit is the release identity on main', (t) => {
	const f = fixture(t);
	f.git('checkout', '-b', 'changeset-release/main');
	f.release();
	f.git('checkout', 'main');
	f.write('feature.txt', 'A main change before the release merge.\n');
	f.commit('Advance main');
	f.git(
		'merge',
		'--no-ff',
		'changeset-release/main',
		'-m',
		'Merge reviewed release PR'
	);
	f.push();
	const merge = f.git('rev-parse', 'HEAD');
	ok(f.app(['tag']));
	assert.match(f.remoteTag(), new RegExp(`^${merge}\\s`));
	ok(f.app(['verify-tag', 'v0.1.1']));
});

test('root and workspace version drift fails without creating a tag', (t) => {
	const f = fixture(t);
	f.release();
	f.json('package.json', { ...f.read('package.json'), version: '0.1.2' });
	f.commit('Invalid version drift');
	f.push();
	assert.notEqual(f.app(['tag']).status, 0);
	assert.equal(f.remoteTag('v0.1.2'), '');
});

test('exact annotated remote tag succeeds without creating or moving a local tag', (t) => {
	const f = fixture(t);
	const release = f.release();
	f.git('tag', '-a', 'v0.1.1', '-m', 'Reviewed release', release);
	f.git('push', 'origin', 'refs/tags/v0.1.1');
	f.git('tag', '-d', 'v0.1.1');
	const refs = f.remoteTag();
	ok(f.app(['tag']));
	assert.equal(f.remoteTag(), refs);
	assert.equal(f.git('tag', '--list'), '');
	f.git('fetch', 'origin', 'tag', 'v0.1.1');
	ok(f.app(['verify-tag', 'v0.1.1']));
});

test('interrupted local tag is pushed on retry', (t) => {
	const f = fixture(t);
	const release = f.release();
	f.git('tag', 'v0.1.1', release);
	ok(f.app(['tag']));
	assert.match(f.remoteTag(), new RegExp(`^${release}\\s`));
});

test('conflicting remote and local-only tags fail without moving either ref', (t) => {
	for (const remote of [false, true]) {
		const f = fixture(t);
		f.release();
		f.git('tag', 'v0.1.1', f.initial);

		if (remote) f.git('push', 'origin', 'refs/tags/v0.1.1');
		const refs = f.remoteTag();
		assert.notEqual(f.app(['tag']).status, 0);
		assert.equal(f.git('rev-parse', 'v0.1.1'), f.initial);
		assert.equal(f.remoteTag(), refs);
	}
});

test('remote errors are not missing tags and a rejected push can recover', (t) => {
	const f = fixture(t);
	const release = f.release();

	const env = interceptGit(
		f,
		`
if (args[0] === process.env.FAIL_GIT_COMMAND) {
  process.stderr.write('fixture transport failure\\n');
  process.exit(128);
}`
	);

	assert.notEqual(
		f.app(['tag'], { ...env, FAIL_GIT_COMMAND: 'ls-remote' }).status,
		0
	);
	assert.equal(f.git('tag', '--list'), '');
	assert.notEqual(
		f.app(['tag'], { ...env, FAIL_GIT_COMMAND: 'push' }).status,
		0
	);
	assert.equal(f.remoteTag(), '');
	ok(f.app(['tag']));
	assert.match(f.remoteTag(), new RegExp(`^${release}\\s`));
});

test('push races reconcile the exact peeled remote target', (t) => {
	for (const conflict of [false, true]) {
		const f = fixture(t);
		const release = f.release();
		const target = conflict ? f.initial : release;

		const env = interceptGit(
			f,
			`
if (args[0] === 'push') {
  const result = spawnSync(realGit, ['-C', remote, '-c', 'user.name=Race', '-c', 'user.email=race@example.invalid', 'tag', '-a', 'v0.1.1', ${JSON.stringify(target)}, '-m', 'Concurrent tag'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status);
}`
		);

		const result = f.app(['tag'], env);

		if (conflict) assert.notEqual(result.status, 0, result.output);
		else ok(result);
		assert.match(
			f.remoteTag(),
			new RegExp(`^${target}\\s+refs/tags/v0\\.1\\.1\\^\\{\\}$`, 'm')
		);
	}
});

test('a lost push acknowledgement still succeeds when origin has the exact tag', (t) => {
	const f = fixture(t);
	f.release();

	const env = interceptGit(
		f,
		`
if (args[0] === 'push') {
  spawnSync(realGit, args, { stdio: 'inherit' });
  process.exit(128);
}`
	);

	ok(f.app(['tag'], env));
	ok(f.app(['verify-tag', 'v0.1.1']));
});

test('verification rejects malformed, CLI, mismatched, and moved tags', (t) => {
	const f = fixture(t);
	f.release();
	ok(f.app(['tag']));

	for (const name of [
		'cli-v0.1.1',
		'v01.1.1',
		'v0.1',
		'v0.1.1-beta.1',
		'v0.1.1+meta',
		'v0.1.1/extra',
		'v0.1.2'
	]) {
		assert.notEqual(f.app(['verify-tag', name]).status, 0, name);
	}

	f.git('tag', '-f', 'v0.1.1', f.initial);
	f.git('push', '--force', 'origin', 'refs/tags/v0.1.1');
	assert.notEqual(f.app(['verify-tag', 'v0.1.1']).status, 0);
});

test('superseded queued releases fail before deployment', (t) => {
	const f = fixture(t);
	const old = f.release();
	ok(f.app(['tag']));
	f.release('0.2.0');
	ok(f.app(['tag']));
	f.git('checkout', '--detach', old);
	assert.match(f.app(['verify-tag', 'v0.1.1']).output, /superseded/);
	assert.notEqual(f.app(['tag']).status, 0);
});

test('release commits outside main ancestry cannot deploy', (t) => {
	const f = fixture(t);
	f.release();
	ok(f.app(['tag']));
	f.git('push', '--force', 'origin', `${f.initial}:refs/heads/main`);
	assert.notEqual(f.app(['verify-tag', 'v0.1.1']).status, 0);
});
