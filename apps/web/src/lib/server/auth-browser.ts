import {
	PasscodeLoginSchema,
	PasskeyEnrollSchema,
	PasskeyIdSchema
} from '@tdrive/shared';
import type { Cookies, RequestEvent, RequestHandler } from '@sveltejs/kit';
import { Effect, Schema } from 'effect';
import { AppConfig } from './config';
import { runEdgeWithEvent, type AppServices } from './edge';
import {
	InvalidRequest,
	MisdirectedRequest,
	Unauthorized,
	type AppError
} from './errors';
import {
	PASSKEY_TTL_SECONDS,
	SESSION_COOKIE,
	SESSION_MAX_AGE_SECONDS,
	passkeyCookieName
} from './auth-policy';
import { authRateLimitResponse } from './auth-rate-limit-response';
import { decodeJson } from './request-json';
import {
	PasskeyEnrollSubmission,
	PasskeyLoginSubmission
} from './passkey-schema';
import { Auth, authorizeRequest } from './services/auth';
import { AuthGuard } from './services/auth-guard';

export const setBrowserSession = (cookies: Cookies, token: string) => {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'strict',
		maxAge: SESSION_MAX_AGE_SECONDS
	});
};

const clearCookie = (cookies: Cookies, name: string) => {
	cookies.delete(name, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'strict'
	});
};

export const clearBrowserSession = (cookies: Cookies) =>
	clearCookie(cookies, SESSION_COOKIE);

const respond = <A extends Response>(
	event: RequestEvent,
	program: Effect.Effect<A, AppError, AppServices>
) => {
	event.setHeaders({ 'Cache-Control': 'private, no-store' });

	return runEdgeWithEvent(
		event,
		Effect.gen(function* () {
			const config = yield* AppConfig;

			if (event.url.origin !== config.dashboardOrigin) {
				return yield* new MisdirectedRequest({
					message: 'Credentials are accepted only on the dashboard origin'
				});
			}

			if (
				event.request.method !== 'GET' &&
				event.request.headers.get('origin') !== config.dashboardOrigin
			) {
				return yield* new InvalidRequest({
					status: 403,
					message: 'The request origin is not allowed'
				});
			}

			return yield* program;
		})
	);
};

const managementSession = (event: RequestEvent) =>
	Effect.gen(function* () {
		if (event.request.headers.has('authorization')) {
			return yield* new InvalidRequest({
				status: 403,
				message: 'Sign in with the passcode to manage passkeys'
			});
		}

		const auth = yield* Auth;
		yield* authorizeRequest(auth, event.request, event.url, event.cookies);
		const token = event.cookies.get(SESSION_COOKIE);

		if (!token)
			return yield* new Unauthorized({
				message: 'A live browser session is required'
			});

		return token;
	});

const consume = (
	event: RequestEvent,
	policy: 'passkeyBegin' | 'passkeyFinish'
) =>
	Effect.gen(function* () {
		const guard = yield* AuthGuard;
		const decision = yield* guard.consume(policy, event.getClientAddress());

		return decision.allowed ? null : authRateLimitResponse(decision);
	});

const passwordControlled = <A>(
	event: RequestEvent,
	program: Effect.Effect<A, AppError>
) =>
	Effect.gen(function* () {
		const guard = yield* AuthGuard;
		const client = event.getClientAddress();
		const lock = yield* guard.checkPasscodeLock(client);

		if (!lock.allowed) return authRateLimitResponse(lock);
		const rate = yield* guard.consume('passcodeLogin', client);

		if (!rate.allowed) return authRateLimitResponse(rate);

		return yield* program.pipe(
			Effect.matchEffect({
				onSuccess: (value) =>
					guard.clearPasscodeFailures(client).pipe(Effect.as(value)),
				onFailure: (failure) => {
					if (
						!(failure instanceof Unauthorized) ||
						failure.message !== 'Passcode is incorrect'
					)
						return Effect.fail(failure);

					return guard
						.recordPasscodeFailure(client)
						.pipe(
							Effect.flatMap((decision) =>
								decision.allowed
									? Effect.fail(failure)
									: Effect.succeed(authRateLimitResponse(decision))
							)
						);
				}
			})
		);
	});

const promptResponse = (
	event: RequestEvent,
	prompt: Effect.Success<ReturnType<(typeof Auth.Service)['startPasskey']>>
) => {
	event.cookies.set(
		passkeyCookieName(prompt.ceremonyId),
		prompt.bindingSecret,
		{
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'strict',
			maxAge: PASSKEY_TTL_SECONDS
		}
	);

	return Response.json({
		ceremonyId: prompt.ceremonyId,
		options: prompt.options
	});
};

export const passkeyLoginOptionsResponse: RequestHandler = (event) =>
	respond(
		event,
		Effect.gen(function* () {
			const limited = yield* consume(event, 'passkeyBegin');

			if (limited) return limited;
			yield* decodeJson(
				event.request,
				Schema.Struct({}),
				'Passkey request is invalid'
			);
			const auth = yield* Auth;

			return promptResponse(event, yield* auth.startPasskey({ kind: 'login' }));
		})
	);

export const passkeyEnrollmentOptionsResponse: RequestHandler = (event) =>
	respond(
		event,
		Effect.gen(function* () {
			const sessionToken = yield* managementSession(event);
			const limited = yield* consume(event, 'passkeyBegin');

			if (limited) return limited;

			const input = yield* decodeJson(
				event.request,
				PasskeyEnrollSchema,
				'A name and current passcode are required'
			);

			const auth = yield* Auth;

			const result = yield* passwordControlled(
				event,
				auth.startPasskey({ kind: 'enroll', sessionToken, ...input })
			);

			return result instanceof Response
				? result
				: promptResponse(event, result);
		})
	);

export const passkeyLoginResponse: RequestHandler = (event) =>
	respond(
		event,
		Effect.gen(function* () {
			const limited = yield* consume(event, 'passkeyFinish');

			if (limited) return limited;

			const input = yield* decodeJson(
				event.request,
				PasskeyLoginSubmission,
				'Passkey response is invalid'
			);

			const cookieName = passkeyCookieName(input.ceremonyId);
			const binding = event.cookies.get(cookieName);

			if (!binding)
				return yield* new Unauthorized({
					message: 'Passkey attempt is missing. Start again.'
				});
			const auth = yield* Auth;

			const token = yield* auth
				.loginWithPasskey({ ...input, binding })
				.pipe(
					Effect.ensuring(
						Effect.sync(() => clearCookie(event.cookies, cookieName))
					)
				);

			setBrowserSession(event.cookies, token);

			return Response.json({ ok: true });
		})
	);

export const passkeyEnrollmentResponse: RequestHandler = (event) =>
	respond(
		event,
		Effect.gen(function* () {
			const sessionToken = yield* managementSession(event);
			const limited = yield* consume(event, 'passkeyFinish');

			if (limited) return limited;

			const input = yield* decodeJson(
				event.request,
				PasskeyEnrollSubmission,
				'Passkey response is invalid'
			);

			const cookieName = passkeyCookieName(input.ceremonyId);
			const binding = event.cookies.get(cookieName);

			if (!binding)
				return yield* new Unauthorized({
					message: 'Passkey attempt is missing. Start again.'
				});
			const auth = yield* Auth;
			yield* auth
				.enrollPasskey({ ...input, binding, sessionToken })
				.pipe(
					Effect.ensuring(
						Effect.sync(() => clearCookie(event.cookies, cookieName))
					)
				);

			return Response.json({ ok: true });
		})
	);

export const passkeyInventoryResponse: RequestHandler = (event) =>
	respond(
		event,
		Effect.gen(function* () {
			const session = yield* managementSession(event);
			const auth = yield* Auth;

			return Response.json({ passkeys: yield* auth.listPasskeys(session) });
		})
	);

export const passkeyRemovalResponse: RequestHandler = (event) =>
	respond(
		event,
		Effect.gen(function* () {
			const sessionToken = yield* managementSession(event);

			const id = yield* Schema.decodeUnknownEffect(PasskeyIdSchema)(
				event.params.id
			).pipe(
				Effect.mapError(
					() =>
						new InvalidRequest({
							status: 400,
							message: 'Passkey id is invalid'
						})
				)
			);

			const input = yield* decodeJson(
				event.request,
				PasscodeLoginSchema,
				'The current passcode is required'
			);

			const auth = yield* Auth;

			const result = yield* passwordControlled(
				event,
				auth.removePasskey({ sessionToken, id, ...input })
			);

			if (result instanceof Response) return result;

			if (result.signedOut) clearBrowserSession(event.cookies);

			return Response.json(result);
		})
	);
