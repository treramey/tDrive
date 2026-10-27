#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = createRequire('/tmp/pw/package.json')('playwright');
const evidence = process.argv[2];
if (!evidence) throw new Error('Pass an evidence directory');
await mkdir(evidence, { recursive: true });
const origin = 'http://localhost:5173';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
	viewport: { width: 1280, height: 950 },
	recordVideo: { dir: join(evidence, 'passkey-video') }
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const actions = [];
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const record = (action, result) => {
	actions.push({ action, result });
	console.log(result);
};
const capture = async (name) => {
	await page.screenshot({
		path: join(evidence, `${name}.png`),
		fullPage: true
	});
	await writeFile(
		join(evidence, `${name}.aria.txt`),
		await page.locator('body').ariaSnapshot()
	);
};
const signInWithPassword = async () => {
	await page
		.getByLabel('Passcode', { exact: true })
		.fill('adrive-verification-local-only');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await page.getByRole('link', { name: 'Settings', exact: true }).waitFor();
};
const signOut = async () => {
	const signedOut = page.waitForResponse(
		(response) =>
			response.url().endsWith('/api/auth/session') &&
			response.request().method() === 'DELETE' &&
			response.status() === 204
	);
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await signedOut;
	await page
		.getByRole('button', { name: 'Sign out', exact: true })
		.waitFor({ state: 'hidden' });
	await page.goto(origin);
	await page.getByRole('heading', { name: 'Sign in to your drive' }).waitFor();
};
const passkeys = () =>
	page.getByRole('region', { name: 'Passkeys', exact: true });
let failure;
let authenticatorId;
try {
	await cdp.send('WebAuthn.enable');
	({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	}));
	await page.goto(origin);
	await page.getByRole('heading', { name: 'Sign in to your drive' }).waitFor();
	await capture('passkey-sign-in');
	await signInWithPassword();
	await page.getByRole('link', { name: 'Settings', exact: true }).click();
	await passkeys().getByText('No passkeys saved.', { exact: false }).waitFor();
	await passkeys()
		.getByLabel('Passkey name', { exact: true })
		.fill('Verification laptop');
	await passkeys()
		.getByLabel('Current passcode to add')
		.fill('adrive-verification-local-only');
	const optionsResponse = page.waitForResponse(
		(response) =>
			response.url().endsWith('/api/auth/passkeys/enroll/options') &&
			response.status() === 200
	);
	await passkeys()
		.getByRole('button', { name: 'Add passkey', exact: true })
		.click();
	const headers = await (await optionsResponse).allHeaders();
	assert.match(headers['set-cookie'], /__Host-adrive-wa-[a-f0-9]{32}=/);
	assert.match(headers['set-cookie'], /HttpOnly/i);
	assert.match(headers['set-cookie'], /Secure/i);
	assert.match(headers['set-cookie'], /SameSite=Strict/i);
	assert.match(headers['set-cookie'], /Max-Age=120/i);
	assert.doesNotMatch(headers['set-cookie'], /Domain=/i);
	assert.match(headers['cache-control'], /no-store/);
	await passkeys().getByText('Passkey added.', { exact: true }).waitFor();
	await page.reload();
	await passkeys().getByText('Verification laptop', { exact: true }).waitFor();
	const saved = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
	assert.equal(saved.credentials.length, 1);
	assert.equal(saved.credentials[0].isResidentCredential, true);
	assert.equal(saved.credentials[0].rpId, 'localhost');
	assert.ok(saved.credentials[0].userHandle);
	record(
		'Enroll in Settings with current passcode, reload, and inspect the CDP authenticator',
		'One persisted resident credential for localhost. Browser binding cookie is Secure, HttpOnly, SameSite Strict, and host-only.'
	);
	await capture('passkey-enrolled');

	const leakedOptions = await context.request.post(
		`${origin}/api/auth/passkeys/login/options`,
		{ headers: { origin }, data: {} }
	);
	assert.equal(leakedOptions.status(), 200);
	const copied = await leakedOptions.json();
	const isolated = await browser.newContext();
	try {
		const noBinding = await isolated.request.post(
			`${origin}/api/auth/passkeys/login/verify`,
			{
				headers: { origin },
				data: {
					ceremonyId: copied.ceremonyId,
					credential: {
						id: 'YQ',
						rawId: 'YQ',
						type: 'public-key',
						clientExtensionResults: {},
						response: {
							clientDataJSON: 'YQ',
							authenticatorData: 'YQ',
							signature: 'YQ',
							userHandle: 'YQ'
						}
					}
				}
			}
		);
		assert.equal(noBinding.status(), 401);
		record(
			'Submit a copied ceremony ID from a second browser context',
			'HTTP 401 without the HttpOnly browser binding.'
		);
	} finally {
		await isolated.close();
	}

	await signOut();
	await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
		authenticatorId,
		enabled: false
	});
	await page
		.getByRole('button', { name: 'Sign in with a passkey', exact: true })
		.click();
	await page
		.getByRole('button', { name: 'Signing in…', exact: true })
		.isDisabled()
		.then((disabled) => assert.equal(disabled, true));
	await page.goto(`${origin}/settings`);
	await page.goto(origin);
	await page
		.getByRole('button', { name: 'Sign in with a passkey', exact: true })
		.waitFor();
	await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
		authenticatorId,
		enabled: true
	});
	record(
		'Navigate away while the real authenticator waits for presence',
		'The request aborts and the sign-in controls remain usable.'
	);

	await page
		.getByRole('button', { name: 'Sign in with a passkey', exact: true })
		.click();
	await page.getByRole('link', { name: 'Settings', exact: true }).waitFor();
	const sessionCookie = (await context.cookies(origin)).find(
		(cookie) => cookie.name === '__Host-adrive-session'
	);
	assert.ok(sessionCookie);
	assert.equal(sessionCookie.secure, true);
	assert.equal(sessionCookie.httpOnly, true);
	assert.equal(sessionCookie.sameSite, 'Strict');
	assert.equal(sessionCookie.domain, 'localhost');
	assert.equal(
		(await context.request.get(`${origin}/api/files`)).status(),
		200
	);
	await page.getByRole('link', { name: 'Settings', exact: true }).click();
	await passkeys().getByText('This session', { exact: true }).waitFor();
	const inventory = await context.request.get(`${origin}/api/auth/passkeys`);
	assert.equal(inventory.status(), 200);
	const list = await inventory.json();
	assert.equal(list.passkeys.length, 1);
	assert.equal(list.passkeys[0].currentSession, true);
	assert.ok(list.passkeys[0].lastUsedAt);
	record(
		'Sign out and sign in using only the CDP passkey',
		'Authenticated files API returns 200. Settings identifies the credential used by this session.'
	);
	await capture('passkey-authenticated');

	await passkeys()
		.getByRole('button', { name: 'Remove Verification laptop', exact: true })
		.click();
	await passkeys()
		.getByText('This is your last passkey.', { exact: false })
		.waitFor();
	await passkeys()
		.getByLabel('Current passcode to remove')
		.fill('adrive-verification-local-only');
	await passkeys()
		.getByRole('button', { name: 'Remove passkey', exact: true })
		.click();
	await page.getByRole('heading', { name: 'Sign in to your drive' }).waitFor();
	assert.equal(
		(await context.request.get(`${origin}/api/files`)).status(),
		401
	);
	assert.equal(
		(await context.cookies(origin)).some(
			(cookie) => cookie.name === '__Host-adrive-session'
		),
		false
	);
	await page
		.getByRole('button', { name: 'Sign in with a passkey', exact: true })
		.click();
	await page
		.getByRole('alert')
		.filter({ hasText: 'Passkey request is invalid' })
		.waitFor();
	assert.equal(
		(await context.request.get(`${origin}/api/files`)).status(),
		401
	);
	record(
		'Remove the current session passkey with the current passcode, then try that authenticator again',
		'The cookie is cleared. Authenticated files and the removed credential both return 401.'
	);
	await capture('passkey-removed');

	await signInWithPassword();
	await page.getByRole('link', { name: 'Settings', exact: true }).click();
	await passkeys().getByText('No passkeys saved.', { exact: false }).waitFor();
	assert.deepEqual(
		(await (await context.request.get(`${origin}/api/auth/passkeys`)).json())
			.passkeys,
		[]
	);
	record(
		'Recover with the passcode and reopen Settings',
		'Password login works with zero passkeys. The inventory stays empty after reload.'
	);
	await capture('passkey-password-recovery');
	await signOut();
	assert.deepEqual(errors, []);
} catch (error) {
	failure = error;
	await capture('passkey-failure').catch(() => {});
} finally {
	if (authenticatorId)
		await cdp
			.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
			.catch(() => {});
	await context.close();
	await browser.close();
	await writeFile(
		join(evidence, 'passkey-actions.json'),
		JSON.stringify(actions, null, 2) + '\n'
	);
	await writeFile(
		join(evidence, 'passkey-result.json'),
		JSON.stringify(
			{
				status: failure ? 'FAIL' : 'PASS',
				browser:
					'Docker Chromium with real CDP CTAP2 resident UV authenticator',
				actions: actions.length,
				errors,
				failure: failure ? String(failure) : null
			},
			null,
			2
		) + '\n'
	);
}
if (failure) throw failure;
console.log(
	`PASS. ${actions.length} passkey browser checks. Evidence saved to ${evidence}.`
);
