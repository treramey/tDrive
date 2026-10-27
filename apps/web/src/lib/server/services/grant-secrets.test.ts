import { readFileSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import { Effect, Layer, Schema } from 'effect';
import { describe, expect, it, onTestFinished } from 'vitest';
import { verifyPrivateGrant } from '../private-grant';
import { Db } from './bindings';
import { GrantSecrets, GrantSecretsLive } from './grant-secrets';

const migration = readFileSync(
	new URL('../../../../migrations/0007_instance_secrets.sql', import.meta.url),
	'utf8'
);

const createDatabase = async (): Promise<D1Database> => {
	const proxy = await getPlatformProxy<{ DB: D1Database }>({
		configPath: 'wrangler.jsonc',
		persist: false
	});

	onTestFinished(() => proxy.dispose());
	const db = proxy.env.DB;
	await db.prepare(migration).run();

	return {
		prepare: db.prepare.bind(db),
		batch: db.batch.bind(db),
		exec: db.exec.bind(db),
		withSession: db.withSession.bind(db),
		dump: db.dump.bind(db)
	};
};

const requestLayer = (db: D1Database) =>
	GrantSecretsLive.pipe(Layer.provide(Layer.succeed(Db, db)));

const mintFromRequest = (
	db: D1Database,
	now = new Date('2026-07-27T12:00:00.000Z')
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const secrets = yield* GrantSecrets;

			return yield* secrets.mint({
				contentOrigin: 'https://content.example.test',
				fileId: 'file-1',
				version: 4,
				now
			});
		}).pipe(Effect.provide(requestLayer(db)))
	);

const verifyFromRequest = (
	db: D1Database,
	grant: Awaited<ReturnType<typeof mintFromRequest>>
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const secrets = yield* GrantSecrets;

			return yield* secrets.verify({
				contentOrigin: 'https://content.example.test',
				requestOrigin: 'https://content.example.test',
				fileId: 'file-1',
				version: 4,
				expiresAtSeconds: grant.expiresAtSeconds,
				signature: grant.signature,
				now: new Date('2026-07-27T12:00:00.000Z')
			});
		}).pipe(Effect.provide(requestLayer(db)))
	);

describe('persisted content grant secrets', () => {
	it('converges concurrent lazy initialization on one D1 row', async () => {
		const db = await createDatabase();

		const [left, right] = await Promise.all([
			mintFromRequest(db),
			mintFromRequest(db)
		]);

		const row = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }))(
			await db.prepare('SELECT count(*) AS count FROM instance_secrets').first()
		);

		expect(row.count).toBe(1);
		await expect(verifyFromRequest(db, left)).resolves.toBe(true);
		await expect(verifyFromRequest(db, right)).resolves.toBe(true);
	});

	it('validates a link across separate request-scoped services', async () => {
		const db = await createDatabase();

		const grant = await mintFromRequest(db);
		await expect(verifyFromRequest(db, grant)).resolves.toBe(true);
		await expect(verifyFromRequest(db, grant)).resolves.toBe(true);
	});

	it('caches the signing key per isolate within the TTL', async () => {
		const db = await createDatabase();
		const prepared = db.prepare.bind(db);
		let secretReads = 0;
		db.prepare = (query: string) => {
			if (/FROM instance_secrets/.test(query)) secretReads += 1;

			return prepared(query);
		};

		await mintFromRequest(db);
		const readsAfterFirst = secretReads;
		await mintFromRequest(db);

		// The first request seeds and reads the key; the second reuses the
		// isolate cache instead of querying D1 again.
		expect(readsAfterFirst).toBeGreaterThan(0);
		expect(secretReads).toBe(readsAfterFirst);
	});

	it('does not let a raw PASSCODE guess validate a persisted-key grant', async () => {
		const db = await createDatabase();
		const grant = await mintFromRequest(db);

		await expect(
			verifyPrivateGrant({
				signingKey: 'the guessed human PASSCODE',
				contentOrigin: 'https://content.example.test',
				requestOrigin: 'https://content.example.test',
				fileId: 'file-1',
				version: 4,
				expiresAtSeconds: grant.expiresAtSeconds,
				signature: grant.signature,
				now: new Date('2026-07-27T12:00:00.000Z')
			})
		).resolves.toBe(false);
	});
});
