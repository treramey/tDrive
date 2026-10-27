import { ApiError, BROWSER_SESSION, request } from './api';
import {
	parsePasskeyEnrollOptions,
	parsePasskeyList,
	parsePasskeyLoginOptions,
	parsePasskeyRemoval
} from './parse';

export const passkeysSupported = () =>
	typeof window !== 'undefined' &&
	window.isSecureContext &&
	typeof window.PublicKeyCredential !== 'undefined';

export const passkeyMessage = (cause: unknown) => {
	if (cause instanceof Error) {
		if (
			cause.name === 'NotAllowedError' ||
			cause.name === 'AbortError' ||
			('code' in cause && cause.code === 'ERROR_CEREMONY_ABORTED')
		) {
			return 'No passkey was used. Try again or use the passcode.';
		}

		if (
			'code' in cause &&
			cause.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'
		)
			return 'This passkey is already saved on this drive.';

		if (
			'code' in cause &&
			cause.code === 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT'
		)
			return 'This device cannot confirm it is you. Use the passcode.';

		if (cause instanceof ApiError) return cause.message;
	}

	return 'The passkey request failed. Try again or use the passcode.';
};

const post = <A>(path: string, body: A, signal?: AbortSignal) =>
	request(`/api/auth/passkeys/${path}`, BROWSER_SESSION, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal
	});

const ceremony = async <A>(
	signal: AbortSignal | undefined,
	run: (browser: typeof import('@simplewebauthn/browser')) => Promise<A>
) => {
	if (!passkeysSupported())
		throw new Error(
			'Passkeys require a supported browser on HTTPS or localhost. Use the passcode.'
		);
	const browser = await import('@simplewebauthn/browser');
	const abort = () => browser.WebAuthnAbortService.cancelCeremony();
	signal?.throwIfAborted();
	signal?.addEventListener('abort', abort, { once: true });

	try {
		return await run(browser);
	} finally {
		signal?.removeEventListener('abort', abort);
	}
};

export const signInWithPasskey = (signal?: AbortSignal) =>
	ceremony(signal, async (browser) => {
		const prompt = parsePasskeyLoginOptions(
			await (await post('login/options', {}, signal)).json()
		);

		const credential = await browser.startAuthentication({
			optionsJSON: prompt.options
		});

		await post(
			'login/verify',
			{ ceremonyId: prompt.ceremonyId, credential },
			signal
		);
	});

export const enrollPasskey = (
	input: { name: string; passcode: string },
	signal?: AbortSignal
) =>
	ceremony(signal, async (browser) => {
		const prompt = parsePasskeyEnrollOptions(
			await (await post('enroll/options', input, signal)).json()
		);

		const credential = await browser.startRegistration({
			optionsJSON: prompt.options
		});

		await post(
			'enroll/verify',
			{ ceremonyId: prompt.ceremonyId, credential },
			signal
		);
	});

export const listPasskeys = async (signal?: AbortSignal) =>
	parsePasskeyList(
		await (
			await request('/api/auth/passkeys', BROWSER_SESSION, { signal })
		).json()
	);

export const removePasskey = async (input: { id: string; passcode: string }) =>
	parsePasskeyRemoval(
		await (
			await request(
				`/api/auth/passkeys/${encodeURIComponent(input.id)}`,
				BROWSER_SESSION,
				{
					method: 'DELETE',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ passcode: input.passcode })
				}
			)
		).json()
	);
