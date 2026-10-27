#!/usr/bin/env node
// Run through browser-proof.sh; dependencies are confined to its container.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { chromium } = createRequire('/tmp/pw/package.json')('playwright');

async function main() {
	const evidence = process.argv[2];
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({
		viewport: { width: 1280, height: 900 },
		recordVideo: { dir: path.join(evidence, 'browser-video') }
	});
	const page = await context.newPage();
	const actions = [];
	const errors = [];
	let failure;
	const log = (action, result) => actions.push({ action, result });
	page.on('pageerror', (error) => errors.push(error.message));
	async function capture(name) {
		await page.screenshot({
			path: path.join(evidence, `${name}.png`),
			fullPage: true
		});
		await fs.writeFile(
			path.join(evidence, `${name}.aria.txt`),
			await page.locator('body').ariaSnapshot()
		);
	}
	try {
		await page.goto('http://localhost:5173');
		await page
			.getByLabel('Passcode', { exact: true })
			.fill('adrive-verification-local-only');
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await page
			.getByRole('button', { name: 'Upload files', exact: true })
			.waitFor();
		log(
			'Sign in using the disposable fixture passcode <redacted>',
			'Empty drive is usable'
		);
		await capture('transfer-before');

		await page
			.getByRole('button', { name: 'Upload files', exact: true })
			.click();
		await page
			.locator('input[type=file][multiple]')
			.setInputFiles(path.join(evidence, 'inputs/verify-note.txt'));
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();
		assert.equal(
			await page
				.getByRole('link', { name: 'Open verify-note.txt', exact: true })
				.count(),
			0
		);
		log(
			'Empty-state Upload files > choose verify-note.txt > Cancel',
			'No file was uploaded'
		);

		await page.getByRole('button', { name: 'Upload', exact: true }).click();
		await page
			.locator('input[type=file][multiple]')
			.setInputFiles(path.join(evidence, 'inputs/verify-note.txt'));
		await page.getByText('1 file selected', { exact: true }).waitFor();
		await capture('transfer-selected');
		const uploaded = page.waitForResponse(
			(response) =>
				response.url().endsWith('/api/files') &&
				response.request().method() === 'PUT'
		);
		await page.getByRole('button', { name: 'Upload 1', exact: true }).click();
		const response = await uploaded;
		assert.equal(response.status(), 201);
		await page
			.getByRole('link', { name: 'Open verify-note.txt', exact: true })
			.waitFor();
		const listingResponse = await context.request.get(
			'http://localhost:5173/api/files'
		);
		assert.equal(listingResponse.status(), 200);
		const listing = await listingResponse.json();
		const savedFile = listing.files.find(
			(file) => file.displayName === 'verify-note.txt'
		);
		assert.ok(savedFile, 'Uploaded file must appear in an independent listing');
		const fileId = savedFile.id;
		await fs.writeFile(
			path.join(evidence, 'transfer-files.json'),
			JSON.stringify(listing, null, 2)
		);
		log('Toolbar Upload > choose verify-note.txt > Upload 1', {
			status: 201,
			fileId
		});
		await capture('transfer-uploaded');

		await page.reload();
		await page
			.getByRole('link', { name: 'Open verify-note.txt', exact: true })
			.click();
		await page
			.getByRole('heading', { name: 'Versions', exact: true })
			.waitFor();
		await page.getByLabel('File preview', { exact: true }).waitFor();
		await page.getByText('v1', { exact: true }).waitFor();
		log(
			'Reload Files > Open verify-note.txt',
			'Persisted detail shows preview and v1'
		);
		await capture('transfer-detail');

		const detailResponse = await context.request.get(
			`http://localhost:5173/api/files/${fileId}`
		);
		assert.equal(detailResponse.status(), 200);
		const detail = await detailResponse.json();
		const source = await fs.readFile(
			path.join(evidence, 'inputs/verify-note.txt')
		);
		assert.equal(detail.file.displayName, 'verify-note.txt');
		assert.equal(detail.file.sizeBytes, source.length);
		assert.equal(detail.file.public, true);
		assert.equal(detail.file.version, 1);
		await fs.writeFile(
			path.join(evidence, 'transfer-detail.json'),
			JSON.stringify(detail, null, 2)
		);
		// A separate context has no dashboard cookie or API credential.
		const anonymous = await browser.newContext();
		try {
			const download = await anonymous.request.get(
				`http://localhost:5174/f/${fileId}`
			);
			assert.equal(download.status(), 200);
			const bytes = await download.body();
			assert.deepEqual(bytes, source);
			await fs.writeFile(path.join(evidence, 'download.txt'), bytes);
			const sha256 = createHash('sha256').update(bytes).digest('hex');
			log('Authenticated metadata GET, then anonymous content-origin GET', {
				metadataStatus: 200,
				contentStatus: 200,
				sizeBytes: bytes.length,
				sourceSha256: sha256,
				downloadedSha256: sha256,
				bytesEqual: true
			});
		} finally {
			await anonymous.close();
		}
		await page.getByRole('button', { name: 'Sign out', exact: true }).click();
		await page
			.getByRole('heading', { name: 'Sign in to your drive', exact: true })
			.waitFor();
		log('Sign out', 'Sign-in page returned');
		assert.deepEqual(errors, []);
	} catch (error) {
		failure = error;
		await capture('failure').catch(() => {});
	} finally {
		await context.close();
		await browser.close();
		await fs.writeFile(
			path.join(evidence, 'browser-actions.json'),
			JSON.stringify(
				{
					status: failure ? 'FAIL' : 'PASS',
					feature: 'transfer-browser',
					actions,
					pageErrors: errors,
					failure: failure?.message,
					traceNote:
						'No raw network trace retained: it would expose session cookies. Video, screenshots, ARIA and sanitized action/status log retained.'
				},
				null,
				2
			)
		);
	}
	if (failure) throw failure;
	console.log(
		'PASS transfer-browser: cancellation, toolbar upload, reload/detail, metadata and anonymous byte equality'
	);
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
