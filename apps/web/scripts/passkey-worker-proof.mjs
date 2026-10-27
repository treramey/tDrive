#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { softwareAuthenticator } from '../src/lib/server/test/fixtures/authenticator.ts';

const require = createRequire(import.meta.url);

const { Miniflare, convertV4MiniflareOptions } = createRequire(
	require.resolve('wrangler/package.json')
)('miniflare');

const root = resolve(import.meta.dirname, '..');
const evidence = process.argv[2];

if (!evidence) throw new Error('Pass an evidence directory');

const origin = 'http://localhost:5173';
const workerMain = join(root, '.svelte-kit/cloudflare/_worker.js');

const { build } = createRequire(require.resolve('wrangler/package.json'))(
	'esbuild'
);

const bundle = await build({
	entryPoints: [workerMain],
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'neutral',
	conditions: ['workerd', 'worker', 'browser'],
	mainFields: ['browser', 'module', 'main'],
	external: ['cloudflare:*', 'node:*']
});

const modules = [
	{ type: 'ESModule', path: workerMain, contents: bundle.outputFiles[0].text }
];

const mf = new Miniflare(
	convertV4MiniflareOptions({
		modules,
		modulesRoot: join(root, '.svelte-kit'),
		compatibilityDate: '2026-07-27',
		compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
		d1Databases: ['DB', 'RESTORE_DB'],
		r2Buckets: ['BUCKET'],
		kvNamespaces: ['AUTH_GUARD'],
		serviceBindings: {
			ASSETS: async () => new Response(null, { status: 404 })
		},
		bindings: {
			DASHBOARD_ORIGIN: origin,
			CONTENT_ORIGIN: 'http://localhost:5174',
			PASSCODE: 'adrive-worker-proof-local-only',
			MAX_UPLOAD_BYTES: '99614720',
			MAX_TOTAL_BYTES: '107374182400',
			SEMANTIC_SEARCH: 'off',
			EMBEDDING_MODEL: '@cf/baai/bge-small-en-v1.5',
			EMBEDDING_POOLING: 'cls',
			EMBEDDING_DIMENSIONS: '384'
		}
	})
);

const cookies = new Map();
const observations = [];

const request = async (path, body, method = 'POST') => {
	const response = await mf.dispatchFetch(origin + path, {
		method,
		headers: {
			origin,
			'cf-connecting-ip': '127.0.0.1',
			'content-type': 'application/json',
			cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
		},
		body: method === 'GET' ? undefined : JSON.stringify(body)
	});

	for (const cookie of response.headers.getSetCookie()) {
		const pair = cookie.split(';', 1)[0];
		const index = pair.indexOf('=');
		cookies.set(pair.slice(0, index), pair.slice(index + 1));
	}

	observations.push({ method, path, status: response.status });

	return response;
};

let failure;

try {
	const db = await mf.getD1Database('DB');

	for (const name of (await readdir(join(root, 'migrations')))
		.filter((file) => file.endsWith('.sql'))
		.sort()) {
		if (name === '0011_passkeys.sql') {
			await db
				.prepare(
					`INSERT INTO dashboard_sessions (token_hash, created_at, expires_at, last_used_at)
				VALUES (?, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
				)
				.bind('0'.repeat(64))
				.run();
		}

		const sql = await readFile(join(root, 'migrations', name), 'utf8');

		for (const statement of require('wrangler').unstable_splitSqlQuery(sql))
			await db.prepare(statement).run();
	}

	assert.deepEqual(
		await db
			.prepare('SELECT * FROM dashboard_sessions WHERE token_hash = ?')
			.bind('0'.repeat(64))
			.first(),
		{
			token_hash: '0'.repeat(64),
			created_at: '2026-01-01T00:00:00.000Z',
			expires_at: '2027-01-01T00:00:00.000Z',
			last_used_at: '2026-01-01T00:00:00.000Z',
			passkey_id: null
		}
	);
	assert.equal(
		await db
			.prepare(
				"SELECT count(*) FROM sqlite_schema WHERE type = 'index' AND name IN ('dashboard_sessions_expiry_idx', 'dashboard_sessions_passkey_idx')"
			)
			.first('count(*)'),
		2
	);
	observations.push({ check: 'populated migration', status: 'PASS' });
	assert.equal(
		(
			await request('/api/auth/session', {
				passcode: 'adrive-worker-proof-local-only'
			})
		).status,
		200
	);

	for (const algorithm of ['ES256', 'RS256']) {
		const device = await softwareAuthenticator(algorithm);

		let response = await request('/api/auth/passkeys/enroll/options', {
			name: algorithm,
			passcode: 'adrive-worker-proof-local-only'
		});

		assert.equal(response.status, 200);
		const enrollment = await response.json();

		const credential = await device.register({
			challenge: enrollment.options.challenge,
			packed: true
		});

		assert.equal(
			(
				await request('/api/auth/passkeys/enroll/verify', {
					ceremonyId: enrollment.ceremonyId,
					credential
				})
			).status,
			200
		);
		response = await request('/api/auth/passkeys/login/options', {});
		assert.equal(response.status, 200);
		const login = await response.json();

		const assertion = await device.assert({
			challenge: login.options.challenge,
			userHandle: enrollment.options.user.id
		});

		const bindingCookies = new Map(cookies);
		assert.equal(
			(
				await request('/api/auth/passkeys/login/verify', {
					ceremonyId: login.ceremonyId,
					credential: assertion
				})
			).status,
			200
		);
		assert.equal(
			(await request('/api/auth/check', undefined, 'GET')).status,
			200
		);

		for (const [name, value] of bindingCookies) cookies.set(name, value);
		assert.equal(
			(
				await request('/api/auth/passkeys/login/verify', {
					ceremonyId: login.ceremonyId,
					credential: assertion
				})
			).status,
			401
		);

		const invalid = await (
			await request('/api/auth/passkeys/login/options', {})
		).json();

		const bad = await device.assert({
			challenge: invalid.options.challenge,
			userHandle: enrollment.options.user.id,
			badSignature: true
		});

		assert.equal(
			(
				await request('/api/auth/passkeys/login/verify', {
					ceremonyId: invalid.ceremonyId,
					credential: bad
				})
			).status,
			401
		);
	}

	const tables = [
		'credential_state',
		'auth_owner',
		'passkeys',
		'dashboard_sessions',
		'passkey_challenges'
	];

	const dump = await db
		.prepare('PRAGMA miniflare_d1_export(?,?,?);')
		.bind(false, false, ...tables)
		.raw();

	const restored = await mf.getD1Database('RESTORE_DB');
	await restored.batch(
		require('wrangler')
			.unstable_splitSqlQuery(dump[0].join('\n'))
			.map((statement) => restored.prepare(statement))
	);

	for (const table of tables) {
		const query = `SELECT * FROM ${table} ORDER BY 1`;
		assert.deepEqual(
			await restored.prepare(query).raw(),
			await db.prepare(query).raw()
		);
	}

	assert.deepEqual(
		await restored.prepare('PRAGMA foreign_key_check').raw(),
		[]
	);

	const restoredKey = await restored
		.prepare("SELECT id FROM passkeys WHERE name = 'ES256'")
		.first('id');

	assert.equal(
		await restored
			.prepare('SELECT count(*) FROM dashboard_sessions WHERE passkey_id = ?')
			.bind(restoredKey)
			.first('count(*)'),
		1
	);
	await restored
		.prepare('DELETE FROM passkeys WHERE id = ?')
		.bind(restoredKey)
		.run();
	assert.equal(
		await restored
			.prepare('SELECT count(*) FROM dashboard_sessions WHERE passkey_id = ?')
			.bind(restoredKey)
			.first('count(*)'),
		0
	);
	assert.equal(
		await restored
			.prepare(
				'SELECT count(*) FROM dashboard_sessions WHERE passkey_id IS NULL'
			)
			.first('count(*)'),
		2
	);
	observations.push({
		check: 'D1 authentication dump restore and cascade',
		status: 'PASS'
	});
} catch (error) {
	failure = error;
} finally {
	await mf.dispose().catch(() => {});
	await mkdir(evidence, { recursive: true });
	await writeFile(
		join(evidence, 'passkey-worker-result.json'),
		JSON.stringify(
			{
				status: failure ? 'FAIL' : 'PASS',
				runtime:
					'Generated production Worker in local workerd with disposable D1 and KV',
				algorithms: ['ES256', 'RS256'],
				observations,
				failure: failure ? String(failure) : null
			},
			null,
			2
		) + '\n'
	);
}

if (failure) throw failure;

console.log(
	'PASS. Populated migration and D1 dump restore preserve sessions. Generated Worker verifies ES256 and RS256 and rejects replays and bad signatures.'
);
