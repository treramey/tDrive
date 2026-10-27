import { decodeRows } from '../decode-rows';
import {
	API_KEY_PATTERN,
	type ApiKey,
	type ApiKeyScope,
	type Passkey
} from '@tdrive/shared';
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/server';
import type { Cookies } from '@sveltejs/kit';
import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import {
	PASSKEY_ALGORITHMS,
	PASSKEY_LIMIT,
	PASSKEY_TTL_SECONDS,
	PASSKEY_USER_VERIFICATION,
	passkeyRelyingParty,
	DEVICE_CODE_TTL_SECONDS,
	DEVICE_POLL_INTERVAL_SECONDS,
	allowsCredentialOrigin,
	bearerToken,
	normalizeApiKeyName,
	normalizeUserCode,
	SESSION_COOKIE,
	SESSION_MAX_AGE_SECONDS,
	shouldTouchLastUsed,
	validateExpiration
} from '../auth-policy';
import { AppConfig } from '../config';
import {
	InvalidRequest,
	MisdirectedRequest,
	StorageError,
	Unauthorized,
	validate
} from '../errors';
import {
	CeremonyIdSchema,
	ClientDataSchema,
	base64url,
	unbase64url,
	type PasskeyEnrollSubmission,
	type PasskeyLoginSubmission
} from '../passkey-schema';
import { Db } from './bindings';

const ApiKeyRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	prefix: Schema.String,
	scope: Schema.Literals(['read-only', 'read-write']),
	secret_hash: Schema.String,
	created_at: Schema.String,
	expires_at: Schema.NullOr(Schema.String),
	last_used_at: Schema.NullOr(Schema.String),
	revoked_at: Schema.NullOr(Schema.String)
});

const SessionRow = Schema.Struct({
	token_hash: Schema.String,
	expires_at: Schema.String,
	last_used_at: Schema.String
});

const DeviceCodeRow = Schema.Struct({
	device_code_hash: Schema.String,
	user_code: Schema.String,
	status: Schema.String,
	interval_seconds: Schema.Int,
	expires_at: Schema.String,
	last_polled_at: Schema.NullOr(Schema.String),
	name: Schema.String
});

export interface AuthorizeInput {
	readonly authorization: string | null;
	readonly sessionToken: string | undefined;
	readonly requestOrigin: string;
	readonly origin: string | null;
	readonly method: string;
}

export interface DeviceAuthorization {
	readonly deviceCode: string;
	readonly userCode: string;
	readonly expiresIn: number;
	readonly interval: number;
}

export type DevicePollResult =
	| { readonly status: 'authorization_pending' | 'slow_down' }
	| { readonly status: 'complete'; readonly apiKey: string };

export interface AuthorizedCredential {
	readonly credentialId: string;
	readonly kind: 'api-key' | 'session';
	readonly scope: ApiKeyScope;
}

type PasskeyFailure = InvalidRequest | Unauthorized | StorageError;

type PasskeyStart =
	| { readonly kind: 'login' }
	| {
			readonly kind: 'enroll';
			readonly sessionToken: string;
			readonly passcode: string;
			readonly name: string;
	  };

type PasskeyPrompt = {
	readonly ceremonyId: typeof CeremonyIdSchema.Type;
	readonly bindingSecret: string;
} & (
	| {
			readonly kind: 'login';
			readonly options: PublicKeyCredentialRequestOptionsJSON;
	  }
	| {
			readonly kind: 'enroll';
			readonly options: PublicKeyCredentialCreationOptionsJSON;
	  }
);

type PasskeyBinding = { readonly binding: string };

export interface AuthService {
	readonly startPasskey: (
		input: PasskeyStart
	) => Effect.Effect<PasskeyPrompt, PasskeyFailure>;
	readonly loginWithPasskey: (
		input: typeof PasskeyLoginSubmission.Type & PasskeyBinding
	) => Effect.Effect<string, PasskeyFailure>;
	readonly enrollPasskey: (
		input: typeof PasskeyEnrollSubmission.Type &
			PasskeyBinding & { readonly sessionToken: string }
	) => Effect.Effect<void, PasskeyFailure>;
	readonly listPasskeys: (
		sessionToken: string
	) => Effect.Effect<ReadonlyArray<Passkey>, PasskeyFailure>;
	readonly removePasskey: (input: {
		readonly sessionToken: string;
		readonly id: string;
		readonly passcode: string;
	}) => Effect.Effect<{ readonly signedOut: boolean }, PasskeyFailure>;
	readonly authorize: (
		input: AuthorizeInput
	) => Effect.Effect<
		AuthorizedCredential,
		MisdirectedRequest | Unauthorized | StorageError
	>;
	readonly createSession: (
		passcode: string
	) => Effect.Effect<string, Unauthorized | StorageError>;
	readonly revokeSession: (
		sessionToken: string | undefined
	) => Effect.Effect<void, StorageError>;
	readonly listApiKeys: Effect.Effect<ReadonlyArray<ApiKey>, StorageError>;
	readonly createApiKey: (
		name: string,
		options?: {
			readonly scope?: ApiKeyScope;
			readonly expiresAt?: string | null;
		}
	) => Effect.Effect<
		{ readonly key: ApiKey; readonly token: string },
		InvalidRequest | StorageError
	>;
	readonly revokeApiKey: (
		id: string
	) => Effect.Effect<void, InvalidRequest | StorageError>;
	readonly createDeviceAuthorization: (
		name: string
	) => Effect.Effect<DeviceAuthorization, InvalidRequest | StorageError>;
	readonly approveDevice: (
		userCode: string
	) => Effect.Effect<void, InvalidRequest | StorageError>;
	readonly denyDevice: (
		userCode: string
	) => Effect.Effect<void, InvalidRequest | StorageError>;
	readonly pollDevice: (
		deviceCode: string
	) => Effect.Effect<
		DevicePollResult,
		InvalidRequest | Unauthorized | StorageError
	>;
	readonly sweepExpired: (limit: number) => Effect.Effect<number, StorageError>;
	// Revokes every browser session and outstanding device code. API keys
	// survive; revoke those individually from the dashboard.
	readonly revokeAllSessions: Effect.Effect<number, StorageError>;
	// Compares the deployed PASSCODE with the recorded hash; on change,
	// revokes all sessions and device codes and records the rotation time.
	readonly enforcePasscodeRotation: Effect.Effect<
		{ readonly rotated: boolean; readonly revoked: number },
		StorageError
	>;
}

export class Auth extends Context.Service<Auth, AuthService>()('app/Auth') {}

const parseUserCode = (value: string) =>
	Effect.try({
		try: () => normalizeUserCode(value),
		catch: (cause) =>
			cause instanceof InvalidRequest
				? cause
				: new InvalidRequest({
						status: 400,
						message: 'Device approval code is invalid'
					})
	});

export const authorizeRequest = (
	auth: AuthService,
	request: Request,
	url: URL,
	cookies: Cookies
) =>
	auth.authorize({
		authorization: request.headers.get('authorization'),
		sessionToken: cookies.get(SESSION_COOKIE),
		requestOrigin: url.origin,
		origin: request.headers.get('origin'),
		method: request.method
	});

// For routes that create, change, or delete data. Read-only API keys are
// authenticated but rejected here with a 403 rather than a 401.
export const authorizeWriteRequest = (
	auth: AuthService,
	request: Request,
	url: URL,
	cookies: Cookies
) =>
	authorizeRequest(auth, request, url, cookies).pipe(
		Effect.flatMap((credential) =>
			credential.scope === 'read-write'
				? Effect.succeed(credential)
				: Effect.fail(
						new InvalidRequest({
							status: 403,
							message: 'This API key is read-only'
						})
					)
		)
	);

const randomToken = (bytes = 32) => {
	const value = new Uint8Array(bytes);
	crypto.getRandomValues(value);

	return btoa(String.fromCharCode(...value))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
};

const randomHex = (bytes: number) => {
	const value = new Uint8Array(bytes);
	crypto.getRandomValues(value);

	return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(
		''
	);
};

const randomUserCode = () => {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);

	const value = Array.from(
		bytes,
		(byte) => alphabet[byte % alphabet.length]
	).join('');

	return `${value.slice(0, 4)}-${value.slice(4)}`;
};

const toHex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');

const hexBytes = (value: string) => {
	const normalized = /^[0-9a-f]{64}$/i.test(value) ? value : '0'.repeat(64);

	return Uint8Array.from({ length: 32 }, (_, index) =>
		Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16)
	);
};

const constantTimeEqual = (left: Uint8Array, right: Uint8Array) => {
	let difference = left.length ^ right.length;

	for (let index = 0; index < left.length; index += 1) {
		difference |= left[index]! ^ (right[index] ?? 0);
	}

	return difference === 0;
};

const hashToken = (token: string) =>
	Effect.promise(() =>
		crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
	).pipe(Effect.map(toHex));

const toApiKey = (row: typeof ApiKeyRow.Type): ApiKey => ({
	id: row.id,
	name: row.name,
	prefix: row.prefix,
	scope: row.scope,
	createdAt: row.created_at,
	expiresAt: row.expires_at,
	lastUsedAt: row.last_used_at,
	revokedAt: row.revoked_at
});

const ChallengeBase = {
	id: CeremonyIdSchema,
	challenge: Schema.String,
	binding_hash: Schema.String,
	auth_epoch: Schema.Int,
	origin: Schema.String,
	rp_id: Schema.String,
	expires_at: Schema.Int,
	consumed_by: Schema.NullOr(Schema.String)
};

const ChallengeRow = Schema.Union([
	Schema.Struct({
		...ChallengeBase,
		purpose: Schema.Literal('login'),
		session_hash: Schema.Null,
		name: Schema.Null
	}),
	Schema.Struct({
		...ChallengeBase,
		purpose: Schema.Literal('enroll'),
		session_hash: Schema.String,
		name: Schema.String
	})
]);

const PasskeyRow = Schema.Struct({
	id: Schema.String,
	public_key: Schema.String,
	name: Schema.String,
	counter: Schema.Int,
	revision: Schema.Int,
	device_type: Schema.Literals(['singleDevice', 'multiDevice']),
	backed_up: Schema.Int,
	created_at: Schema.String,
	last_used_at: Schema.NullOr(Schema.String)
});

const CredentialState = Schema.Struct({
	auth_epoch: Schema.Int,
	passcode_hash: Schema.String
});

const BrowserSessionRow = Schema.Struct({
	token_hash: Schema.String,
	passkey_id: Schema.NullOr(Schema.String)
});

const invalidPasskey = () =>
	new Unauthorized({
		message:
			'Passkey request is invalid or expired. Try again or use the passcode.'
	});

const stalePasskey = () =>
	new InvalidRequest({
		status: 409,
		message: 'Passkey access changed. Start again or use the passcode.'
	});

const makeAuth = Effect.gen(function* () {
	const db = yield* Db;
	const sql = (yield* SqlClient.SqlClient).withoutTransforms();
	const config = yield* AppConfig;

	const storage = <A>(operation: string, run: () => Promise<A>) =>
		Effect.tryPromise({
			try: run,
			catch: (cause) => new StorageError({ operation, cause })
		});

	const query = <A, I>(
		schema: Schema.Codec<A, I, never>,
		statement: D1PreparedStatement
	) =>
		storage('read passkey state', async () => {
			const result = await statement.all();

			return Schema.decodeUnknownSync(Schema.Array(schema))(result.results);
		});

	const assertPasscode = (passcode: string) =>
		Effect.gen(function* () {
			const expected = yield* hashToken(config.passcode);
			const actual = yield* hashToken(passcode);

			if (!constantTimeEqual(hexBytes(expected), hexBytes(actual))) {
				return yield* new Unauthorized({ message: 'Passcode is incorrect' });
			}
		});

	const sessionMaterial = Effect.gen(function* () {
		const token = randomToken();
		const hash = yield* hashToken(token);
		const now = new Date();

		return {
			token,
			hash,
			createdAt: now.toISOString(),
			expiresAt: new Date(
				now.getTime() + SESSION_MAX_AGE_SECONDS * 1000
			).toISOString()
		};
	});

	const sessionInsert = (
		material: Effect.Success<typeof sessionMaterial>,
		source: {
			readonly id: string;
			readonly ceremonyId: string;
			readonly marker: string;
		} | null
	) =>
		db
			.prepare(
				`INSERT INTO dashboard_sessions (token_hash, created_at, expires_at, last_used_at, passkey_id)
			SELECT ?, ?, ?, ?, ? WHERE ? IS NULL OR EXISTS (
				SELECT 1 FROM passkey_challenges WHERE id = ? AND consumed_by = ?
			)`
			)
			.bind(
				material.hash,
				material.createdAt,
				material.expiresAt,
				material.createdAt,
				source?.id ?? null,
				source?.ceremonyId ?? null,
				source?.ceremonyId ?? null,
				source?.marker ?? null
			);

	const currentState = Effect.gen(function* () {
		const hash = yield* hashToken(config.passcode);
		yield* storage('initialize credential state', () =>
			db
				.prepare(
					`INSERT INTO credential_state (id, passcode_hash, rotated_at)
			VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING`
				)
				.bind(hash, new Date().toISOString())
				.run()
		);

		const rows = yield* query(
			CredentialState,
			db.prepare(
				'SELECT auth_epoch, passcode_hash FROM credential_state WHERE id = 1'
			)
		);

		const state = rows[0];

		if (!state || state.passcode_hash !== hash) return yield* stalePasskey();

		return { epoch: state.auth_epoch, hash };
	});

	const browserSession = (token: string) =>
		Effect.gen(function* () {
			const hash = yield* hashToken(token);

			const rows = yield* query(
				BrowserSessionRow,
				db
					.prepare(
						`SELECT token_hash, passkey_id FROM dashboard_sessions
			WHERE token_hash = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
					)
					.bind(hash)
			);

			const row = rows[0];

			if (!row)
				return yield* new Unauthorized({
					message: 'Sign in with the passcode to manage passkeys'
				});

			return row;
		});

	const ownerHandle = Effect.gen(function* () {
		yield* storage('initialize passkey owner', () =>
			db
				.prepare(
					'INSERT INTO auth_owner (id, user_handle) VALUES (1, ?) ON CONFLICT(id) DO NOTHING'
				)
				.bind(randomToken())
				.run()
		);

		const rows = yield* query(
			Schema.Struct({ user_handle: Schema.String }),
			db.prepare('SELECT user_handle FROM auth_owner WHERE id = 1')
		);

		const row = rows[0];

		if (!row)
			return yield* new StorageError({
				operation: 'read passkey owner',
				cause: 'Owner is missing'
			});

		return row.user_handle;
	});

	const loadChallenge = (
		input: {
			readonly ceremonyId: typeof CeremonyIdSchema.Type;
			readonly binding: string;
		},
		purpose: 'login' | 'enroll'
	) =>
		Effect.gen(function* () {
			const site = yield* validate(() =>
				passkeyRelyingParty(config.dashboardOrigin)
			);

			const state = yield* currentState;
			const bindingHash = yield* hashToken(input.binding);

			const rows = yield* query(
				ChallengeRow,
				db
					.prepare('SELECT * FROM passkey_challenges WHERE id = ?')
					.bind(input.ceremonyId)
			);

			const row = rows[0];

			if (
				!row ||
				row.purpose !== purpose ||
				row.consumed_by !== null ||
				row.expires_at <= Math.floor(Date.now() / 1000) ||
				row.binding_hash !== bindingHash ||
				row.auth_epoch !== state.epoch ||
				row.origin !== site.origin ||
				row.rp_id !== site.id
			) {
				return yield* invalidPasskey();
			}

			return { row, state, site, bindingHash };
		});

	const checkClientData = (encoded: string) =>
		Effect.gen(function* () {
			const json = yield* Schema.decodeUnknownEffect(
				Schema.UnknownFromJsonString
			)(new TextDecoder().decode(unbase64url(encoded))).pipe(
				Effect.mapError(invalidPasskey)
			);

			const data = yield* Schema.decodeUnknownEffect(ClientDataSchema)(
				json
			).pipe(Effect.mapError(invalidPasskey));

			if (data.crossOrigin === true) return yield* invalidPasskey();
		});

	const claimChallenge = (input: {
		readonly row: typeof ChallengeRow.Type;
		readonly hash: string;
		readonly marker: string;
		readonly bindingHash: string;
		readonly credentialId: string;
		readonly revision: number | null;
	}) =>
		db
			.prepare(
				`UPDATE passkey_challenges SET consumed_by = ?1
		WHERE id = ?2 AND consumed_by IS NULL AND binding_hash = ?3 AND expires_at > unixepoch()
			AND auth_epoch = ?4 AND origin = ?5 AND rp_id = ?6 AND purpose = ?7
			AND EXISTS (SELECT 1 FROM credential_state WHERE id = 1 AND auth_epoch = ?4 AND passcode_hash = ?8)
			AND ((purpose = 'login' AND EXISTS (SELECT 1 FROM passkeys WHERE id = ?9 AND revision = ?10))
				OR (purpose = 'enroll' AND created_at > unixepoch() - ?11
					AND session_hash = ?12 AND EXISTS (SELECT 1 FROM dashboard_sessions WHERE token_hash = ?12 AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
					AND (SELECT count(*) FROM passkeys) < ?13 AND NOT EXISTS (SELECT 1 FROM passkeys WHERE id = ?9)))`
			)
			.bind(
				input.marker,
				input.row.id,
				input.bindingHash,
				input.row.auth_epoch,
				input.row.origin,
				input.row.rp_id,
				input.row.purpose,
				input.hash,
				input.credentialId,
				input.revision,
				PASSKEY_TTL_SECONDS,
				input.row.session_hash,
				PASSKEY_LIMIT
			);

	const requireCommitted = (results: D1Result[]) =>
		Effect.gen(function* () {
			if (results.some((result) => result.meta.changes !== 1))
				return yield* stalePasskey();
		});

	const makeApiKey = Effect.fn('Auth.makeApiKey')(function* (name: string) {
		const normalizedName = yield* validate(() => normalizeApiKeyName(name));
		const prefix = randomHex(4);
		const token = `adr_${prefix}_${randomToken()}`;
		const secretHash = yield* hashToken(token);
		const id = crypto.randomUUID();
		const createdAt = new Date().toISOString();

		return {
			token,
			secretHash,
			row: {
				id,
				name: normalizedName,
				prefix,
				createdAt
			}
		};
	});

	const listApiKeys = sql`
		SELECT id, name, prefix, scope, secret_hash, created_at, expires_at,
			last_used_at, revoked_at
		FROM api_keys
		ORDER BY created_at DESC, id
	`.pipe(
		Effect.map((rows) => decodeRows(ApiKeyRow)(rows).map(toApiKey)),
		Effect.mapError(
			(cause) => new StorageError({ operation: 'list API keys', cause })
		),
		Effect.withSpan('Auth.listApiKeys')
	);

	return Auth.of({
		authorize: Effect.fn('Auth.authorize')(function* ({
			authorization,
			sessionToken,
			requestOrigin,
			origin,
			method
		}) {
			if (requestOrigin !== config.dashboardOrigin) {
				return yield* new MisdirectedRequest({
					message: 'Credentials are accepted only on the dashboard origin'
				});
			}

			const bearer = bearerToken(authorization);

			if (bearer) {
				const match = API_KEY_PATTERN.exec(bearer);

				if (!match) {
					return yield* new Unauthorized({
						message: 'A valid credential is required'
					});
				}

				const rows = yield* sql`
					SELECT id, name, prefix, scope, secret_hash, created_at, expires_at,
						last_used_at, revoked_at
					FROM api_keys
					WHERE prefix = ${match[1]} AND revoked_at IS NULL
					LIMIT 1
				`.pipe(
					Effect.mapError(
						(cause) => new StorageError({ operation: 'look up API key', cause })
					)
				);

				const row = decodeRows(ApiKeyRow)(rows)[0];
				const actualHash = yield* hashToken(bearer);

				if (
					!row ||
					!constantTimeEqual(hexBytes(actualHash), hexBytes(row.secret_hash))
				) {
					return yield* new Unauthorized({
						message: 'A valid credential is required'
					});
				}

				const now = new Date();
				const nowIso = now.toISOString();

				if (row.expires_at !== null && row.expires_at <= nowIso) {
					return yield* new Unauthorized({
						message: 'This API key has expired'
					});
				}

				if (shouldTouchLastUsed(row.last_used_at, now)) {
					yield* sql`
						UPDATE api_keys
						SET last_used_at = ${nowIso}
						WHERE id = ${row.id}
					`.pipe(
						Effect.mapError(
							(cause) =>
								new StorageError({ operation: 'update API key usage', cause })
						)
					);
				}

				return {
					credentialId: row.id,
					kind: 'api-key' as const,
					scope: row.scope
				};
			}

			if (!sessionToken) {
				return yield* new Unauthorized({
					message: 'A valid credential is required'
				});
			}

			if (!allowsCredentialOrigin(method, origin, config.dashboardOrigin)) {
				return yield* new Unauthorized({
					message: 'The request origin is not allowed'
				});
			}

			const tokenHash = yield* hashToken(sessionToken);
			const now = new Date();
			const nowIso = now.toISOString();

			const rows = yield* sql`
				SELECT token_hash, expires_at, last_used_at
				FROM dashboard_sessions
				WHERE token_hash = ${tokenHash} AND expires_at > ${nowIso}
				LIMIT 1
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'look up dashboard session', cause })
				)
			);

			const row = decodeRows(SessionRow)(rows)[0];

			if (!row) {
				return yield* new Unauthorized({
					message: 'A valid credential is required'
				});
			}

			if (shouldTouchLastUsed(row.last_used_at, now)) {
				yield* sql`
					UPDATE dashboard_sessions SET last_used_at = ${nowIso}
					WHERE token_hash = ${tokenHash}
				`.pipe(
					Effect.mapError(
						(cause) =>
							new StorageError({
								operation: 'update dashboard session',
								cause
							})
					)
				);
			}

			return {
				credentialId: row.token_hash,
				kind: 'session' as const,
				scope: 'read-write' as const
			};
		}),
		startPasskey: Effect.fn('Auth.startPasskey')(function* (input) {
			const site = yield* validate(() =>
				passkeyRelyingParty(config.dashboardOrigin)
			);

			let sessionHash: string | null = null;
			let name: string | null = null;

			if (input.kind === 'enroll') {
				sessionHash = (yield* browserSession(input.sessionToken)).token_hash;
				yield* assertPasscode(input.passcode);
				name = yield* validate(() => normalizeApiKeyName(input.name));
			}

			const state = yield* currentState;
			const handle = yield* ownerHandle;

			const ceremonyId = yield* Schema.decodeUnknownEffect(CeremonyIdSchema)(
				randomHex(16)
			).pipe(Effect.orDie);

			const bindingSecret = randomToken();
			const bindingHash = yield* hashToken(bindingSecret);
			const challenge = randomToken();

			const rows = yield* query(
				Schema.Struct({ id: Schema.String }),
				db.prepare('SELECT id FROM passkeys')
			);

			if (input.kind === 'enroll' && rows.length >= PASSKEY_LIMIT)
				return yield* new InvalidRequest({
					status: 409,
					message:
						'Remove a passkey before adding another. You can save up to 8.'
				});

			const result = yield* storage('start passkey attempt', () =>
				db
					.prepare(
						`INSERT INTO passkey_challenges
				(id, purpose, challenge, binding_hash, auth_epoch, origin, rp_id, created_at, expires_at, session_hash, name)
				SELECT ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch() + ?, ?, ?
				WHERE EXISTS (SELECT 1 FROM credential_state WHERE id = 1 AND auth_epoch = ? AND passcode_hash = ?)
				AND (? IS NULL OR EXISTS (SELECT 1 FROM dashboard_sessions WHERE token_hash = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`
					)
					.bind(
						ceremonyId,
						input.kind,
						challenge,
						bindingHash,
						state.epoch,
						site.origin,
						site.id,
						PASSKEY_TTL_SECONDS,
						sessionHash,
						name,
						state.epoch,
						state.hash,
						sessionHash,
						sessionHash
					)
					.run()
			);

			yield* requireCommitted([result]);

			if (input.kind === 'login') {
				const options = yield* Effect.promise(() =>
					generateAuthenticationOptions({
						rpID: site.id,
						challenge: unbase64url(challenge),
						timeout: PASSKEY_TTL_SECONDS * 1000,
						userVerification: PASSKEY_USER_VERIFICATION,
						allowCredentials: []
					})
				);

				return { kind: 'login' as const, ceremonyId, bindingSecret, options };
			}

			const options = yield* Effect.promise(() =>
				generateRegistrationOptions({
					rpID: site.id,
					rpName: 'tdrive',
					userName: 'owner',
					userDisplayName: 'tdrive owner',
					userID: unbase64url(handle),
					challenge: unbase64url(challenge),
					timeout: PASSKEY_TTL_SECONDS * 1000,
					attestationType: 'none',
					supportedAlgorithmIDs: PASSKEY_ALGORITHMS,
					authenticatorSelection: {
						residentKey: 'required',
						userVerification: PASSKEY_USER_VERIFICATION
					},
					excludeCredentials: [...rows]
				})
			);

			return { kind: 'enroll' as const, ceremonyId, bindingSecret, options };
		}),
		enrollPasskey: Effect.fn('Auth.enrollPasskey')(function* (input) {
			const { row, state, site, bindingHash } = yield* loadChallenge(
				input,
				'enroll'
			);

			const session = yield* browserSession(input.sessionToken);

			if (row.purpose !== 'enroll' || row.session_hash !== session.token_hash)
				return yield* invalidPasskey();
			yield* checkClientData(input.credential.response.clientDataJSON);

			const result = yield* Effect.tryPromise({
				try: () =>
					verifyRegistrationResponse({
						response: input.credential,
						expectedChallenge: row.challenge,
						expectedOrigin: site.origin,
						expectedRPID: site.id,
						requireUserPresence: true,
						requireUserVerification: true,
						supportedAlgorithmIDs: PASSKEY_ALGORITHMS
					}),
				catch: invalidPasskey
			});

			if (!result.verified) return yield* invalidPasskey();
			const info = result.registrationInfo;
			const marker = randomToken();

			const results = yield* storage('enroll passkey', () =>
				db.batch([
					claimChallenge({
						row,
						hash: state.hash,
						marker,
						bindingHash,
						credentialId: info.credential.id,
						revision: null
					}),
					db
						.prepare(
							`INSERT INTO passkeys (id, public_key, name, counter, device_type, backed_up, created_at)
					SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM passkey_challenges WHERE id = ? AND consumed_by = ?)`
						)
						.bind(
							info.credential.id,
							base64url(info.credential.publicKey),
							row.name,
							info.credential.counter,
							info.credentialDeviceType,
							Number(info.credentialBackedUp),
							new Date().toISOString(),
							row.id,
							marker
						)
				])
			);

			yield* requireCommitted(results);
		}),
		loginWithPasskey: Effect.fn('Auth.loginWithPasskey')(function* (input) {
			const { row, state, site, bindingHash } = yield* loadChallenge(
				input,
				'login'
			);

			const handle = yield* ownerHandle;

			if (input.credential.response.userHandle !== handle)
				return yield* invalidPasskey();

			const rows = yield* query(
				PasskeyRow,
				db
					.prepare('SELECT * FROM passkeys WHERE id = ?')
					.bind(input.credential.id)
			);

			const credential = rows[0];

			if (!credential) return yield* invalidPasskey();
			yield* checkClientData(input.credential.response.clientDataJSON);

			const result = yield* Effect.tryPromise({
				try: () =>
					verifyAuthenticationResponse({
						response: input.credential,
						expectedChallenge: row.challenge,
						expectedOrigin: site.origin,
						expectedRPID: site.id,
						requireUserVerification: true,
						credential: {
							id: credential.id,
							publicKey: unbase64url(credential.public_key),
							counter: credential.counter
						}
					}),
				catch: invalidPasskey
			});

			if (!result.verified) return yield* invalidPasskey();
			const material = yield* sessionMaterial;
			const marker = randomToken();
			const info = result.authenticationInfo;

			const results = yield* storage('sign in with passkey', () =>
				db.batch([
					claimChallenge({
						row,
						hash: state.hash,
						marker,
						bindingHash,
						credentialId: credential.id,
						revision: credential.revision
					}),
					sessionInsert(material, {
						id: credential.id,
						ceremonyId: row.id,
						marker
					}),
					db
						.prepare(
							`UPDATE passkeys SET counter = ?, revision = revision + 1, last_used_at = ?, device_type = ?, backed_up = ?
					WHERE id = ? AND EXISTS (SELECT 1 FROM passkey_challenges WHERE id = ? AND consumed_by = ?)`
						)
						.bind(
							info.newCounter,
							material.createdAt,
							info.credentialDeviceType,
							Number(info.credentialBackedUp),
							credential.id,
							row.id,
							marker
						)
				])
			);

			yield* requireCommitted(results);

			return material.token;
		}),
		listPasskeys: Effect.fn('Auth.listPasskeys')(function* (sessionToken) {
			yield* currentState;
			const session = yield* browserSession(sessionToken);

			const rows = yield* query(
				PasskeyRow,
				db.prepare('SELECT * FROM passkeys ORDER BY created_at, id')
			);

			return rows.map((row) => ({
				id: row.id,
				name: row.name,
				createdAt: row.created_at,
				lastUsedAt: row.last_used_at,
				deviceType: row.device_type,
				backedUp: row.backed_up === 1,
				currentSession: row.id === session.passkey_id
			}));
		}),
		removePasskey: Effect.fn('Auth.removePasskey')(function* (input) {
			yield* assertPasscode(input.passcode);
			const state = yield* currentState;
			const hash = yield* hashToken(input.sessionToken);

			const results = yield* storage('remove passkey', () =>
				db.batch([
					db
						.prepare(
							`SELECT passkey_id FROM dashboard_sessions WHERE token_hash = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
					AND EXISTS (SELECT 1 FROM credential_state WHERE id = 1 AND auth_epoch = ? AND passcode_hash = ?)`
						)
						.bind(hash, state.epoch, state.hash),
					db
						.prepare(
							`DELETE FROM passkeys WHERE id = ? AND EXISTS (SELECT 1 FROM dashboard_sessions WHERE token_hash = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
					AND EXISTS (SELECT 1 FROM credential_state WHERE id = 1 AND auth_epoch = ? AND passcode_hash = ?)`
						)
						.bind(input.id, hash, state.epoch, state.hash)
				])
			);

			const rows = yield* Schema.decodeUnknownEffect(
				Schema.Array(
					Schema.Struct({ passkey_id: Schema.NullOr(Schema.String) })
				)
			)(results[0]?.results).pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'read passkey removal', cause })
				)
			);

			const session = rows[0];

			if (!session)
				return yield* new Unauthorized({
					message: 'A live browser session is required'
				});

			return { signedOut: session.passkey_id === input.id };
		}),
		createSession: Effect.fn('Auth.createSession')(function* (passcode) {
			yield* assertPasscode(passcode);
			const material = yield* sessionMaterial;
			yield* storage('create dashboard session', () =>
				sessionInsert(material, null).run()
			);

			return material.token;
		}),
		revokeSession: Effect.fn('Auth.revokeSession')(function* (sessionToken) {
			if (!sessionToken) return;
			const hash = yield* hashToken(sessionToken);
			yield* storage('revoke session attempts', () =>
				db
					.prepare('DELETE FROM passkey_challenges WHERE session_hash = ?')
					.bind(hash)
					.run()
			);
			yield* sql`DELETE FROM dashboard_sessions WHERE token_hash = ${hash}`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'revoke dashboard session', cause })
				)
			);
		}),
		listApiKeys,
		createApiKey: Effect.fn('Auth.createApiKey')(function* (name, options) {
			const scope = options?.scope ?? 'read-write';

			const expiresAt = yield* Effect.try({
				try: () => validateExpiration(options?.expiresAt ?? null),
				catch: (cause) =>
					cause instanceof InvalidRequest
						? cause
						: new InvalidRequest({
								status: 400,
								message: 'Key expiration is invalid'
							})
			});

			const generated = yield* makeApiKey(name);
			yield* sql`
				INSERT INTO api_keys (
					id, name, prefix, scope, secret_hash, created_at, expires_at
				) VALUES (
					${generated.row.id}, ${generated.row.name}, ${generated.row.prefix},
					${scope}, ${generated.secretHash}, ${generated.row.createdAt},
					${expiresAt}
				)
			`.pipe(
				Effect.mapError(
					(cause) => new StorageError({ operation: 'create API key', cause })
				)
			);

			return {
				key: {
					...generated.row,
					scope,
					expiresAt,
					lastUsedAt: null,
					revokedAt: null
				},
				token: generated.token
			};
		}),
		revokeApiKey: Effect.fn('Auth.revokeApiKey')(function* (id) {
			const result = yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`UPDATE api_keys
							SET revoked_at = ?
							WHERE id = ? AND revoked_at IS NULL`
						)
						.bind(new Date().toISOString(), id)
						.run(),
				catch: (cause) =>
					new StorageError({ operation: 'revoke API key', cause })
			});

			if (result.meta.changes !== 1) {
				return yield* new InvalidRequest({
					status: 404,
					message: 'API key was not found'
				});
			}
		}),
		createDeviceAuthorization: Effect.fn('Auth.createDeviceAuthorization')(
			function* (name) {
				const normalizedName = yield* validate(() => normalizeApiKeyName(name));
				const deviceCode = randomToken(32);
				const deviceCodeHash = yield* hashToken(deviceCode);
				const createdAt = new Date();

				const expiresAt = new Date(
					createdAt.getTime() + DEVICE_CODE_TTL_SECONDS * 1000
				);

				let userCode = randomUserCode();

				for (let attempt = 0; attempt < 5; attempt += 1) {
					const result = yield* Effect.tryPromise({
						try: () =>
							db
								.prepare(
									`INSERT INTO device_codes (
									device_code_hash, user_code, status, interval_seconds,
									expires_at, created_at, name
								) VALUES (?, ?, 'pending', ?, ?, ?, ?)
								ON CONFLICT(user_code) DO NOTHING`
								)
								.bind(
									deviceCodeHash,
									userCode,
									DEVICE_POLL_INTERVAL_SECONDS,
									expiresAt.toISOString(),
									createdAt.toISOString(),
									normalizedName
								)
								.run(),
						catch: (cause) =>
							new StorageError({
								operation: 'create device authorization',
								cause
							})
					});

					if (result.meta.changes === 1) {
						return {
							deviceCode,
							userCode,
							expiresIn: DEVICE_CODE_TTL_SECONDS,
							interval: DEVICE_POLL_INTERVAL_SECONDS
						};
					}

					userCode = randomUserCode();
				}

				return yield* new StorageError({
					operation: 'create device authorization',
					cause: 'Could not allocate a unique approval code'
				});
			}
		),
		approveDevice: Effect.fn('Auth.approveDevice')(function* (userCode) {
			const code = yield* parseUserCode(userCode);
			const now = new Date().toISOString();

			const result = yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`UPDATE device_codes
							SET status = 'approved', approved_at = ?
							WHERE user_code = ? AND status = 'pending' AND expires_at > ?`
						)
						.bind(now, code, now)
						.run(),
				catch: (cause) =>
					new StorageError({ operation: 'approve device', cause })
			});

			if (result.meta.changes !== 1) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Device approval code is invalid or expired'
				});
			}
		}),
		denyDevice: Effect.fn('Auth.denyDevice')(function* (userCode) {
			const code = yield* parseUserCode(userCode);
			const now = new Date().toISOString();

			const result = yield* Effect.tryPromise({
				try: () =>
					db
						.prepare(
							`UPDATE device_codes
							SET status = 'denied'
							WHERE user_code = ? AND status = 'pending' AND expires_at > ?`
						)
						.bind(code, now)
						.run(),
				catch: (cause) => new StorageError({ operation: 'deny device', cause })
			});

			if (result.meta.changes !== 1) {
				return yield* new InvalidRequest({
					status: 400,
					message: 'Device approval code is invalid or expired'
				});
			}
		}),
		pollDevice: Effect.fn('Auth.pollDevice')(function* (deviceCode) {
			if (deviceCode.length < 32 || deviceCode.length > 128) {
				return yield* new Unauthorized({
					message: 'Device authorization is invalid'
				});
			}

			const hash = yield* hashToken(deviceCode);

			const rows = yield* sql`
				SELECT
					device_code_hash, user_code, status, interval_seconds, expires_at,
					last_polled_at, name
				FROM device_codes
				WHERE device_code_hash = ${hash}
				LIMIT 1
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'poll device authorization', cause })
				)
			);

			const row = decodeRows(DeviceCodeRow)(rows)[0];

			if (!row) {
				return yield* new Unauthorized({
					message: 'Device authorization is invalid'
				});
			}

			const now = new Date();

			if (new Date(row.expires_at).getTime() <= now.getTime()) {
				yield* sql`
					UPDATE device_codes SET status = 'expired'
					WHERE device_code_hash = ${hash} AND status IN ('pending', 'approved')
				`.pipe(
					Effect.mapError(
						(cause) =>
							new StorageError({
								operation: 'expire device authorization',
								cause
							})
					)
				);

				return yield* new Unauthorized({
					message: 'Device authorization expired'
				});
			}

			const lastPoll = row.last_polled_at
				? new Date(row.last_polled_at).getTime()
				: 0;

			if (
				row.status === 'pending' &&
				now.getTime() - lastPoll < row.interval_seconds * 1000
			) {
				return { status: 'slow_down' as const };
			}

			yield* sql`
				UPDATE device_codes SET last_polled_at = ${now.toISOString()}
				WHERE device_code_hash = ${hash}
			`.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'record device poll', cause })
				)
			);

			if (row.status === 'pending') {
				return { status: 'authorization_pending' as const };
			}

			if (row.status !== 'approved') {
				return yield* new Unauthorized({
					message: 'Device authorization is no longer available'
				});
			}

			const generated = yield* makeApiKey(row.name);
			const consumedAt = now.toISOString();

			const results = yield* Effect.tryPromise({
				try: () =>
					db.batch([
						db
							.prepare(
								`INSERT INTO api_keys (
									id, name, prefix, secret_hash, created_at
								)
								SELECT ?, ?, ?, ?, ?
								WHERE EXISTS (
									SELECT 1 FROM device_codes
									WHERE device_code_hash = ? AND status = 'approved'
								)`
							)
							.bind(
								generated.row.id,
								generated.row.name,
								generated.row.prefix,
								generated.secretHash,
								generated.row.createdAt,
								hash
							),
						db
							.prepare(
								`UPDATE device_codes
								SET status = 'consumed', consumed_at = ?, api_key_id = ?
								WHERE device_code_hash = ? AND status = 'approved'`
							)
							.bind(consumedAt, generated.row.id, hash)
					]),
				catch: (cause) =>
					new StorageError({
						operation: 'complete device authorization',
						cause
					})
			});

			if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
				return yield* new Unauthorized({
					message: 'Device authorization was already consumed'
				});
			}

			return { status: 'complete' as const, apiKey: generated.token };
		}),
		revokeAllSessions: Effect.gen(function* () {
			const results = yield* Effect.tryPromise({
				try: () =>
					db.batch([
						db.prepare(
							'UPDATE credential_state SET auth_epoch = auth_epoch + 1 WHERE id = 1'
						),
						db.prepare('DELETE FROM passkey_challenges'),
						db.prepare('DELETE FROM dashboard_sessions'),
						db.prepare(
							`UPDATE device_codes SET status = 'denied'
							WHERE status IN ('pending', 'approved')`
						)
					]),
				catch: (cause) =>
					new StorageError({ operation: 'revoke all sessions', cause })
			});

			return results
				.slice(2)
				.reduce((count, result) => count + (result.meta.changes ?? 0), 0);
		}).pipe(Effect.withSpan('Auth.revokeAllSessions')),
		enforcePasscodeRotation: Effect.gen(function* () {
			const passcodeHash = yield* hashToken(config.passcode);
			const now = new Date().toISOString();

			// One transactional batch (D1 batches are transactions): seed the
			// row on first boot without revoking anything, revoke while the
			// stored hash still differs from the deployed one, then record the
			// new hash. A failure anywhere rolls the whole claim back, so a
			// rotation can never be marked recorded with revocation skipped.
			const results = yield* Effect.tryPromise({
				try: () =>
					db.batch([
						db
							.prepare(
								`INSERT INTO credential_state (id, passcode_hash, rotated_at)
								VALUES (1, ?1, ?2)
								ON CONFLICT(id) DO NOTHING`
							)
							.bind(passcodeHash, now),
						db
							.prepare(
								`DELETE FROM dashboard_sessions
								WHERE EXISTS (
									SELECT 1 FROM credential_state
									WHERE id = 1 AND passcode_hash <> ?1
								)`
							)
							.bind(passcodeHash),
						db
							.prepare(
								`UPDATE device_codes SET status = 'denied'
								WHERE status IN ('pending', 'approved')
									AND EXISTS (
										SELECT 1 FROM credential_state
										WHERE id = 1 AND passcode_hash <> ?1
									)`
							)
							.bind(passcodeHash),
						db
							.prepare(
								`DELETE FROM passkey_challenges WHERE EXISTS (SELECT 1 FROM credential_state WHERE id = 1 AND passcode_hash <> ?)`
							)
							.bind(passcodeHash),
						db
							.prepare(
								`DELETE FROM passkeys WHERE EXISTS (SELECT 1 FROM credential_state WHERE id = 1 AND passcode_hash <> ?)`
							)
							.bind(passcodeHash),
						db
							.prepare(
								`UPDATE credential_state
								SET passcode_hash = ?1, rotated_at = ?2, auth_epoch = auth_epoch + 1
								WHERE id = 1 AND passcode_hash <> ?1`
							)
							.bind(passcodeHash, now)
					]),
				catch: (cause) =>
					new StorageError({
						operation: 'enforce passcode rotation',
						cause
					})
			});

			const rotated = results[5]?.meta.changes === 1;

			return {
				rotated,
				revoked: rotated
					? (results[1]?.meta.changes ?? 0) + (results[2]?.meta.changes ?? 0)
					: 0
			};
		}).pipe(Effect.withSpan('Auth.enforcePasscodeRotation')),
		sweepExpired: Effect.fn('Auth.sweepExpired')(function* (limit) {
			const bounded = Math.max(1, Math.min(limit, 100));
			const now = new Date().toISOString();

			const cutoff = new Date(
				new Date(now).getTime() - 24 * 60 * 60 * 1_000
			).toISOString();

			const results = yield* Effect.tryPromise({
				try: () =>
					db.batch([
						db
							.prepare(
								`DELETE FROM passkey_challenges WHERE id IN (SELECT id FROM passkey_challenges WHERE expires_at <= unixepoch() ORDER BY expires_at LIMIT ?)`
							)
							.bind(bounded),
						db
							.prepare(
								`DELETE FROM dashboard_sessions
								WHERE token_hash IN (
									SELECT token_hash FROM dashboard_sessions
									WHERE expires_at <= ?
									ORDER BY expires_at
									LIMIT ?
								)`
							)
							.bind(now, bounded),
						db
							.prepare(
								`DELETE FROM device_codes
								WHERE device_code_hash IN (
									SELECT device_code_hash FROM device_codes
									WHERE expires_at <= ?
										OR (status = 'consumed' AND consumed_at <= ?)
									ORDER BY expires_at
									LIMIT ?
								)`
							)
							.bind(now, cutoff, bounded)
					]),
				catch: (cause) =>
					new StorageError({
						operation: 'sweep expired authentication state',
						cause
					})
			});

			return results.reduce(
				(count, result) => count + (result.meta.changes ?? 0),
				0
			);
		})
	});
});

export const AuthLive = Layer.effect(Auth, makeAuth);
