import { Effect, Schema } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PasskeyListResponseSchema } from '@tdrive/shared';
import { Auth } from '../services/auth';
import { runWorkerProgram } from '../edge';
import {
	createRouteContext,
	call,
	type RouteTestContext
} from '../test/route-context';
import { softwareAuthenticator } from '../test/fixtures/authenticator';
import { passkeyCookieName, SESSION_COOKIE } from '../auth-policy';
import {
	passkeyEnrollmentOptionsResponse as enrollOptions,
	passkeyEnrollmentResponse as enrollVerify,
	passkeyLoginOptionsResponse as loginOptions,
	passkeyLoginResponse as loginVerify,
	passkeyInventoryResponse as inventory,
	passkeyRemovalResponse as remove
} from '../auth-browser';
import {
	POST as passwordLogin,
	DELETE as logout
} from '../../../routes/api/auth/session/+server';

vi.mock('$app/server', async () =>
	(await import('../test/route-context')).mockGetRequestEvent()
);

const Prompt = Schema.Struct({
	ceremonyId: Schema.String,
	options: Schema.Struct({
		challenge: Schema.String,
		user: Schema.optional(Schema.Struct({ id: Schema.String }))
	})
});
type Authenticator = Awaited<ReturnType<typeof softwareAuthenticator>>;
let ctx: RouteTestContext;
const send = async <E>(
	handler: (event: E) => Response | Promise<Response>,
	input: {
		path?: string;
		method?: string;
		body?: unknown;
		headers?: Record<string, string>;
		browser?: RouteTestContext;
		params?: Record<string, string>;
		client?: string;
	} = {}
) => {
	const browser = input.browser ?? ctx;
	const event = browser.event({
		path: input.path ?? '/api/auth/passkeys',
		method: input.method ?? 'POST',
		body:
			input.method === 'GET'
				? undefined
				: input.body === undefined
					? '{}'
					: JSON.stringify(input.body),
		headers: { 'content-type': 'application/json', ...input.headers },
		params: input.params
	});
	return call(handler, {
		...event,
		getClientAddress: () => input.client ?? crypto.randomUUID()
	});
};
const auth = <A>(
	f: (service: typeof Auth.Service) => Effect.Effect<A, unknown>
) =>
	runWorkerProgram(
		ctx.env,
		Effect.gen(function* () {
			return yield* f(yield* Auth);
		})
	);
const password = async (browser = ctx) => {
	const response = await send(passwordLogin, {
		browser,
		path: '/api/auth/session',
		body: { passcode: ctx.env.PASSCODE }
	});
	expect(response.status).toBe(200);
};
const startEnroll = async (name = 'Laptop') => {
	const response = await send(enrollOptions, {
		body: { name, passcode: ctx.env.PASSCODE }
	});
	expect(response.status).toBe(200);
	return Schema.decodeUnknownSync(Prompt)(await response.json());
};
const enroll = async (device: Authenticator, packed = false) => {
	const prompt = await startEnroll();
	const credential = await device.register({
		challenge: prompt.options.challenge,
		packed
	});
	const result = await send(enrollVerify, {
		body: { ceremonyId: prompt.ceremonyId, credential }
	});
	expect(result.status).toBe(200);
	const handle = prompt.options.user?.id;
	if (!handle)
		throw new Error('Registration did not supply the stable owner handle');
	return handle;
};
const startLogin = async () => {
	const response = await send(loginOptions);
	expect(response.status).toBe(200);
	return Schema.decodeUnknownSync(Prompt)(await response.json());
};
const assertion = async (
	device: Authenticator,
	userHandle: string,
	options: Partial<Parameters<Authenticator['assert']>[0]> = {}
) => {
	const prompt = await startLogin();
	return {
		ceremonyId: prompt.ceremonyId,
		credential: await device.assert({
			challenge: prompt.options.challenge,
			userHandle,
			...options
		})
	};
};
const list = async () =>
	Schema.decodeUnknownSync(PasskeyListResponseSchema)(
		await (
			await call(inventory, ctx.event({ path: '/api/auth/passkeys' }))
		).json()
	);
const count = async (
	table: 'dashboard_sessions' | 'passkeys' | 'passkey_challenges'
) => {
	const row = await ctx.env.DB.prepare(
		`SELECT count(*) AS count FROM ${table}`
	).first('count');
	return row;
};
const freezeCommits = (target = 1) => {
	const original = ctx.env.DB;
	const claims = new WeakSet<D1PreparedStatement>();
	const reached = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	let arrivals = 0;
	ctx.env.DB = new Proxy(original, {
		get(db, property) {
			if (property === 'prepare')
				return (sql: string) => {
					const statement = db.prepare(sql);
					if (!sql.startsWith('UPDATE passkey_challenges SET consumed_by'))
						return statement;
					return new Proxy(statement, {
						get(value, key) {
							if (key === 'bind')
								return (...params: unknown[]) => {
									const bound = value.bind(...params);
									claims.add(bound);
									return bound;
								};
							return Reflect.get(value, key);
						}
					});
				};
			if (property === 'batch')
				return async (statements: D1PreparedStatement[]) => {
					if (statements.some((item) => claims.has(item))) {
						arrivals++;
						if (arrivals === target) reached.resolve();
						await resume.promise;
					}
					return db.batch(statements);
				};
			const value: unknown = Reflect.get(db, property);
			return typeof value === 'function' ? value.bind(db) : value;
		}
	});
	return {
		reached: reached.promise,
		resume: () => resume.resolve(),
		restore: () => {
			ctx.env.DB = original;
		}
	};
};

beforeEach(async () => {
	ctx = await createRouteContext();
	await ctx.env.DB.batch(
		[
			'DELETE FROM passkey_challenges',
			'DELETE FROM dashboard_sessions',
			'DELETE FROM passkeys',
			'DELETE FROM credential_state'
		].map((sql) => ctx.env.DB.prepare(sql))
	);
	await auth((service) => service.enforcePasscodeRotation);
	await password();
});

describe('passkeys with real signatures and local workerd D1/KV', () => {
	it.each(['ES256', 'RS256'] as const)(
		'enrolls and logs in without a password using %s, including signed self-attestation',
		async (algorithm) => {
			const device = await softwareAuthenticator(algorithm);
			const handle = await enroll(device, true);
			expect((await list()).passkeys).toMatchObject([
				{ id: device.id, name: 'Laptop', currentSession: false }
			]);
			await send(logout, { method: 'DELETE', path: '/api/auth/session' });
			const input = await assertion(device, handle);
			expect((await send(loginVerify, { body: input })).status).toBe(200);
			expect((await list()).passkeys).toMatchObject([{ currentSession: true }]);
		}
	);

	it.each([
		{ badSignature: true },
		{ flags: 1 },
		{ flags: 4 },
		{ origin: 'https://evil.example' },
		{ origin: 'http://localhost:5174' },
		{ rp: 'evil.example' },
		{ userHandle: 'd3Jvbmc' },
		{ challenge: 'd3Jvbmc' },
		{ crossOrigin: true }
	])(
		'rejects a signed assertion with invalid evidence %j without locking password recovery',
		async (mutation) => {
			const device = await softwareAuthenticator();
			const handle = await enroll(device);
			const before = await count('dashboard_sessions');
			await expect(
				send(loginVerify, { body: await assertion(device, handle, mutation) })
			).rejects.toMatchObject({ status: 401 });
			expect(await count('dashboard_sessions')).toBe(before);
			await password();
		}
	);

	it('rejects malformed encoding, ID mismatch, and missing user handle', async () => {
		const device = await softwareAuthenticator();
		const handle = await enroll(device);
		for (const field of ['rawId', 'signature', 'userHandle']) {
			const input = await assertion(device, handle);
			const credential =
				field === 'rawId'
					? { ...input.credential, rawId: 'different' }
					: {
							...input.credential,
							response: {
								...input.credential.response,
								[field]: field === 'signature' ? 'bad=' : undefined
							}
						};
			await expect(
				send(loginVerify, { body: { ...input, credential } })
			).rejects.toMatchObject({ status: 400 });
		}
	});

	it('binds attempts to their browser cookie, purpose and expiry', async () => {
		const device = await softwareAuthenticator();
		const handle = await enroll(device);
		const input = await assertion(device, handle);
		const browser = await createRouteContext();
		await expect(
			send(loginVerify, { browser, body: input })
		).rejects.toMatchObject({ status: 401 });
		ctx.cookies.set(passkeyCookieName(input.ceremonyId), 'wrong-browser');
		await expect(send(loginVerify, { body: input })).rejects.toMatchObject({
			status: 401
		});
		const expired = await assertion(device, handle);
		await ctx.env.DB.prepare(
			'UPDATE passkey_challenges SET expires_at = 0 WHERE id = ?'
		)
			.bind(expired.ceremonyId)
			.run();
		await expect(send(loginVerify, { body: expired })).rejects.toMatchObject({
			status: 401
		});
		const enrollPrompt = await startEnroll();
		await expect(
			send(loginVerify, {
				body: {
					ceremonyId: enrollPrompt.ceremonyId,
					credential: await device.assert({
						challenge: enrollPrompt.options.challenge,
						userHandle: handle
					})
				}
			})
		).rejects.toMatchObject({ status: 401 });
	});

	it('requires a live original session at enrollment completion', async () => {
		const device = await softwareAuthenticator();
		const prompt = await startEnroll();
		const credential = await device.register({
			challenge: prompt.options.challenge
		});
		await send(logout, { path: '/api/auth/session', method: 'DELETE' });
		await password();
		await expect(
			send(enrollVerify, {
				body: { ceremonyId: prompt.ceremonyId, credential }
			})
		).rejects.toMatchObject({ status: 401 });
		expect(await count('passkeys')).toBe(0);
	});

	it.each(['read-only', 'read-write'] as const)(
		'rejects %s bearer credentials on every management route, even alongside a session',
		async (scope) => {
			const key = await auth((service) =>
				service.createApiKey('passkey-test', { scope })
			);
			const headers = { authorization: `Bearer ${key.token}` };
			await expect(
				send(inventory, { method: 'GET', headers })
			).rejects.toMatchObject({ status: 403 });
			await expect(
				send(enrollOptions, {
					headers,
					body: { name: 'Key', passcode: ctx.env.PASSCODE }
				})
			).rejects.toMatchObject({ status: 403 });
			await expect(send(enrollVerify, { headers })).rejects.toMatchObject({
				status: 403
			});
			await expect(
				send(remove, {
					method: 'DELETE',
					headers,
					params: { id: 'missing' },
					body: { passcode: ctx.env.PASSCODE }
				})
			).rejects.toMatchObject({ status: 403 });
		}
	);

	it('rejects wrong request origins and content-host direct handlers', async () => {
		await expect(
			send(loginOptions, { headers: { origin: 'http://localhost:5174' } })
		).rejects.toMatchObject({ status: 403 });
		await expect(
			send(loginOptions, {
				path: 'http://localhost:5174/api/auth/passkeys/login/options'
			})
		).rejects.toMatchObject({ status: 421 });
	});

	it('consumes a successful challenge once even with the binding cookie restored', async () => {
		const device = await softwareAuthenticator();
		const handle = await enroll(device);
		const input = await assertion(device, handle);
		const name = passkeyCookieName(input.ceremonyId);
		const binding = ctx.cookies.get(name);
		expect((await send(loginVerify, { body: input })).status).toBe(200);
		if (!binding) throw new Error('Missing binding fixture');
		ctx.cookies.set(name, binding);
		const before = await count('dashboard_sessions');
		await expect(send(loginVerify, { body: input })).rejects.toMatchObject({
			status: 401
		});
		expect(await count('dashboard_sessions')).toBe(before);
	});

	it.each([false, true])(
		'allows exactly one concurrent zero-counter assertion when ceremonies differ = %s',
		async (distinct) => {
			const device = await softwareAuthenticator();
			const handle = await enroll(device);
			const first = await assertion(device, handle);
			const second = distinct ? await assertion(device, handle) : first;
			const before = await count('dashboard_sessions');
			const gate = freezeCommits(2);
			const one = send(loginVerify, { body: first });
			const two = send(loginVerify, { body: second });
			const outcomes = Promise.allSettled([one, two]);
			await gate.reached;
			gate.resume();
			try {
				const results = await outcomes;
				expect(
					results.filter((result) => result.status === 'fulfilled')
				).toHaveLength(1);
				expect(
					results.filter((result) => result.status === 'rejected')
				).toHaveLength(1);
				expect(await count('dashboard_sessions')).toBe(Number(before) + 1);
				expect(
					await ctx.env.DB.prepare('SELECT revision FROM passkeys WHERE id = ?')
						.bind(device.id)
						.first('revision')
				).toBe(1);
			} finally {
				gate.restore();
			}
		}
	);

	it('accepts zero then increasing counters and rejects equal or decreasing positive counters', async () => {
		const device = await softwareAuthenticator();
		const handle = await enroll(device);
		for (const counter of [0, 0, 1, 2])
			expect(
				(
					await send(loginVerify, {
						body: await assertion(device, handle, { counter })
					})
				).status
			).toBe(200);
		for (const counter of [2, 1, 0])
			await expect(
				send(loginVerify, {
					body: await assertion(device, handle, { counter })
				})
			).rejects.toMatchObject({ status: 401 });
	});

	it.each(['remove', 'logout', 'rotate', 'expire'] as const)(
		'gates every write when %s invalidates a verified assertion before commit',
		async (change) => {
			const device = await softwareAuthenticator();
			const handle = await enroll(device);
			const input = await assertion(device, handle);
			const gate = freezeCommits();
			const completion = send(loginVerify, { body: input });
			const result = Promise.allSettled([completion]);
			await gate.reached;
			try {
				if (change === 'remove')
					await send(remove, {
						method: 'DELETE',
						params: { id: device.id },
						body: { passcode: ctx.env.PASSCODE }
					});
				if (change === 'logout')
					await auth((service) => service.revokeAllSessions);
				if (change === 'rotate') {
					ctx.env.PASSCODE = 'changed-passcode-for-test';
					await auth((service) => service.enforcePasscodeRotation);
				}
				if (change === 'expire')
					await ctx.env.DB.prepare(
						'UPDATE passkey_challenges SET expires_at = 0 WHERE id = ?'
					)
						.bind(input.ceremonyId)
						.run();
				const before = await count('dashboard_sessions');
				gate.resume();
				expect((await result)[0]?.status).toBe('rejected');
				expect(await count('dashboard_sessions')).toBe(before);
				if (change === 'expire')
					expect(
						await ctx.env.DB.prepare(
							'SELECT revision FROM passkeys WHERE id = ?'
						)
							.bind(device.id)
							.first('revision')
					).toBe(0);
			} finally {
				gate.resume();
				gate.restore();
			}
		}
	);

	it('cascades passkey sessions on removal, preserves password sessions, and makes missing removal idempotent', async () => {
		const passwordToken = ctx.cookies.get(SESSION_COOKIE);
		const device = await softwareAuthenticator();
		const handle = await enroll(device);
		await send(loginVerify, { body: await assertion(device, handle) });
		const response = await send(remove, {
			method: 'DELETE',
			params: { id: device.id },
			body: { passcode: ctx.env.PASSCODE }
		});
		expect(await response.json()).toEqual({ signedOut: true });
		expect(ctx.cookies.get(SESSION_COOKIE)).toBeUndefined();
		if (!passwordToken) throw new Error('Missing password session');
		ctx.cookies.set(SESSION_COOKIE, passwordToken);
		expect((await list()).passkeys).toEqual([]);
		expect(
			(
				await send(remove, {
					method: 'DELETE',
					params: { id: device.id },
					body: { passcode: ctx.env.PASSCODE }
				})
			).status
		).toBe(200);
		await expect(
			send(loginVerify, { body: await assertion(device, handle) })
		).rejects.toMatchObject({ status: 401 });
		await password();
	});

	it('fails closed before rotation maintenance and preserves the stable owner through recovery', async () => {
		const device = await softwareAuthenticator();
		const handle = await enroll(device);
		const input = await assertion(device, handle);
		ctx.env.PASSCODE = 'rotated-current-passcode';
		await expect(send(loginVerify, { body: input })).rejects.toMatchObject({
			status: 409
		});
		await password();
		await auth((service) => service.enforcePasscodeRotation);
		expect(await count('passkeys')).toBe(0);
		expect(await count('passkey_challenges')).toBe(0);
		await password();
		const next = await startEnroll();
		expect(next.options.user?.id).toBe(handle);
	});

	it('preserves passkeys across global logout and allows a new login afterward', async () => {
		const device = await softwareAuthenticator();
		const handle = await enroll(device);
		const old = await assertion(device, handle);
		await auth((service) => service.revokeAllSessions);
		await expect(send(loginVerify, { body: old })).rejects.toMatchObject({
			status: 401
		});
		expect(
			(await send(loginVerify, { body: await assertion(device, handle) }))
				.status
		).toBe(200);
	});

	it('enforces the eight-key cap atomically across two enrollments at the final slot', async () => {
		for (let index = 0; index < 7; index++)
			await enroll(await softwareAuthenticator());
		const devices = await Promise.all([
			softwareAuthenticator(),
			softwareAuthenticator()
		]);
		const inputs = [];
		for (const device of devices) {
			const prompt = await startEnroll();
			inputs.push({
				ceremonyId: prompt.ceremonyId,
				credential: await device.register({
					challenge: prompt.options.challenge
				})
			});
		}
		const gate = freezeCommits(2);
		const results = Promise.allSettled(
			inputs.map((body) => send(enrollVerify, { body }))
		);
		await gate.reached;
		gate.resume();
		try {
			expect(
				(await results).filter((result) => result.status === 'fulfilled')
			).toHaveLength(1);
			expect(await count('passkeys')).toBe(8);
		} finally {
			gate.restore();
		}
	});

	it('separates begin and finish rate controls from password recovery', async () => {
		for (let index = 0; index < 10; index++)
			expect((await send(loginOptions, { client: 'rate-begin' })).status).toBe(
				200
			);
		expect((await send(loginOptions, { client: 'rate-begin' })).status).toBe(
			429
		);
		for (let index = 0; index < 30; index++)
			await expect(
				send(loginVerify, { client: 'rate-finish' })
			).rejects.toMatchObject({ status: 400 });
		expect((await send(loginVerify, { client: 'rate-finish' })).status).toBe(
			429
		);
		for (const client of ['rate-begin', 'rate-finish'])
			expect(
				(
					await send(passwordLogin, {
						client,
						body: { passcode: ctx.env.PASSCODE }
					})
				).status
			).toBe(200);
	});

	it('requires the current password for enrollment and removal', async () => {
		const device = await softwareAuthenticator();
		await enroll(device);
		await expect(
			send(enrollOptions, {
				body: { name: 'Stolen session', passcode: 'wrong-password' }
			})
		).rejects.toMatchObject({ status: 401 });
		await expect(
			send(remove, {
				method: 'DELETE',
				params: { id: device.id },
				body: { passcode: 'wrong-password' }
			})
		).rejects.toMatchObject({ status: 401 });
		expect((await list()).passkeys).toHaveLength(1);
	});

	it.each(['session', 'fingerprint'] as const)(
		'gates enrollment after its %s changes during verification',
		async (change) => {
			const device = await softwareAuthenticator();
			const prompt = await startEnroll();
			const credential = await device.register({
				challenge: prompt.options.challenge
			});
			const gate = freezeCommits();
			const outcome = Promise.allSettled([
				send(enrollVerify, {
					body: { ceremonyId: prompt.ceremonyId, credential }
				})
			]);
			await gate.reached;
			try {
				if (change === 'session')
					await ctx.env.DB.prepare('DELETE FROM dashboard_sessions').run();
				else
					await ctx.env.DB.prepare(
						'UPDATE credential_state SET passcode_hash = ? WHERE id = 1'
					)
						.bind('0'.repeat(64))
						.run();
				gate.resume();
				expect((await outcome)[0]?.status).toBe('rejected');
				expect(await count('passkeys')).toBe(0);
				expect(
					await ctx.env.DB.prepare(
						'SELECT consumed_by FROM passkey_challenges WHERE id = ?'
					)
						.bind(prompt.ceremonyId)
						.first('consumed_by')
				).toBeNull();
			} finally {
				gate.resume();
				gate.restore();
			}
		}
	);

	it('rolls back a winning claim when a later statement fails', async () => {
		const device = await softwareAuthenticator();
		const handle = await enroll(device);
		const input = await assertion(device, handle);
		const before = await count('dashboard_sessions');
		await ctx.env.DB.prepare(
			"CREATE TRIGGER fail_passkey_session BEFORE INSERT ON dashboard_sessions WHEN NEW.passkey_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"
		).run();
		const logging = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await expect(send(loginVerify, { body: input })).rejects.toMatchObject({
				status: 502
			});
			expect(await count('dashboard_sessions')).toBe(before);
			expect(
				await ctx.env.DB.prepare(
					'SELECT consumed_by FROM passkey_challenges WHERE id = ?'
				)
					.bind(input.ceremonyId)
					.first('consumed_by')
			).toBeNull();
			expect(
				await ctx.env.DB.prepare('SELECT revision FROM passkeys WHERE id = ?')
					.bind(device.id)
					.first('revision')
			).toBe(0);
		} finally {
			logging.mockRestore();
			await ctx.env.DB.prepare('DROP TRIGGER fail_passkey_session').run();
		}
	});

	it('rejects oversized streamed bodies and unsafe cookie suffixes', async () => {
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('x'.repeat(17000)));
				controller.close();
			}
		});
		await expect(
			call(
				loginVerify,
				ctx.event({
					path: '/api/auth/passkeys/login/verify',
					method: 'POST',
					body: stream
				})
			)
		).rejects.toMatchObject({ status: 413 });
		for (const id of ['x', 'A'.repeat(32), '0'.repeat(32) + '; injected=1'])
			expect(() => passkeyCookieName(id)).toThrow();
	});
});
