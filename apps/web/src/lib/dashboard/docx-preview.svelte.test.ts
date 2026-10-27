import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import { createSubscriber } from 'svelte/reactivity';
import type { DashboardFile } from '@tdrive/shared';
import DocxPreview from '$lib/components/files/DocxPreview.svelte';
import FilePreview from '$lib/components/files/FilePreview.svelte';
import FileThumb from '$lib/components/files/FileThumb.svelte';
import { loadDocxPreview, type DocxWorkerResult } from './docx-preview';
import {
	docxConversionTimeoutMs,
	docxMediaType,
	maxDocxOutputBytes,
	maxDocxPreviewBytes
} from '$lib/file-preview';

const workers: PreviewWorker[] = [];

class PreviewWorker {
	onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
	onerror: (() => void) | null = null;
	onmessageerror: (() => void) | null = null;
	postMessage = vi.fn();
	terminate = vi.fn();
	constructor() {
		workers.push(this);
	}
	complete(result: DocxWorkerResult) {
		this.onmessage?.(new MessageEvent('message', { data: result }));
	}
}

const fetchMock = vi.fn<typeof fetch>();

const file: DashboardFile = {
	id: 'docx-private',
	version: 2,
	displayName: 'report.docx',
	contentType: docxMediaType,
	sizeBytes: 50,
	public: false,
	kind: 'file',
	createdAt: '2026-01-01T00:00:00.000Z',
	expiresAt: null,
	deletedAt: null,
	downloadCount: 0,
	lastDownloadAt: null,
	indexState: 'disabled',
	indexedVersion: null,
	indexAttempts: 0,
	indexError: null,
	tags: [],
	htmlForcedPublic: false,
	updatedAt: '2026-01-01T00:00:00.000Z'
};

const mounted: ReturnType<typeof mount>[] = [];

const mountPreview = () => {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const ondownload = vi.fn();
	mounted.push(
		mount(DocxPreview, {
			target,
			props: { file, token: 'private-token', ondownload }
		})
	);

	return { target, ondownload };
};

const nextWorker = async (index = 0) => {
	await vi.waitFor(() => expect(workers.length).toBe(index + 1));
	const worker = workers[index];

	if (!worker) throw new Error('Missing worker');

	return worker;
};

beforeEach(() => {
	workers.length = 0;
	vi.stubGlobal('Worker', PreviewWorker);
	vi.stubGlobal(
		'fetch',
		fetchMock.mockImplementation(
			async () =>
				new Response(new Uint8Array([80, 75]), {
					headers: { 'X-Adrive-Preview-Kind': 'docx' }
				})
		)
	);
});

afterEach(async () => {
	for (const component of mounted.splice(0)) await unmount(component);
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	fetchMock.mockReset();
});

describe('DOCX detail preview', () => {
	it('dispatches a DOCX file detail to the worker instead of the text API', async () => {
		const target = document.createElement('div');
		document.body.appendChild(target);
		mounted.push(
			mount(FilePreview, {
				target,
				props: {
					file,
					token: 'private-token',
					contentOrigin: 'https://content.example',
					ondownload: () => {}
				}
			})
		);
		const worker = await nextWorker();
		worker.complete({
			kind: 'converted',
			hasErrors: false,
			html: '<h1>Document detail</h1>'
		});
		await vi.waitFor(() =>
			expect(target.querySelector('h1')?.textContent).toBe('Document detail')
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(target.querySelector('[role="alert"]')).toBeNull();
	});

	it.each([
		{
			contentType: 'text/plain',
			displayName: 'text.docx',
			body: 'Plain text',
			kind: 'text',
			selector: 'pre'
		},
		{
			contentType: 'text/markdown',
			displayName: 'notes.md',
			body: '# Markdown notes',
			kind: 'markdown',
			selector: 'h1'
		}
	])(
		'preserves $kind preview rendering',
		async ({ contentType, displayName, body, kind, selector }) => {
			fetchMock.mockImplementationOnce(
				async () =>
					new Response(body, { headers: { 'X-Adrive-Preview-Kind': kind } })
			);
			const target = document.createElement('div');
			document.body.appendChild(target);
			mounted.push(
				mount(FilePreview, {
					target,
					props: {
						file: { ...file, id: kind, contentType, displayName },
						token: 'private-token',
						contentOrigin: 'https://content.example',
						ondownload: () => {}
					}
				})
			);
			await vi.waitFor(() =>
				expect(target.querySelector(selector)?.textContent).toContain(
					body.replace(/^# /, '')
				)
			);
			expect(workers).toHaveLength(0);
		}
	);

	it('preserves versioned native image preview URLs', async () => {
		const target = document.createElement('div');
		document.body.appendChild(target);
		mounted.push(
			mount(FilePreview, {
				target,
				props: {
					file: {
						...file,
						public: true,
						contentType: 'image/png',
						displayName: 'photo.png'
					},
					token: 'private-token',
					contentOrigin: 'https://content.example',
					ondownload: () => {}
				}
			})
		);
		await vi.waitFor(() =>
			expect(target.querySelector('img')?.src).toBe(
				'https://content.example/f/docx-private?v=2'
			)
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(workers).toHaveLength(0);
	});

	it('renders semantic text nodes without making generated markup live', async () => {
		const { target } = mountPreview();
		const worker = await nextWorker();
		worker.complete({
			kind: 'converted',
			hasErrors: false,
			html: '<h1>Report</h1><p>&lt;img src=x onerror=alert(1)&gt;<a href="https://example.com">Source</a></p><ul><li>Finding</li></ul><table><tr><td>Cell</td></tr></table>'
		});
		await vi.waitFor(() =>
			expect(target.querySelector('h1')?.textContent).toBe('Report')
		);
		expect(target.querySelector('p')?.textContent).toBe(
			'<img src=x onerror=alert(1)>Source'
		);
		expect(target.querySelector('li')?.textContent).toBe('Finding');
		expect(target.querySelector('td')?.textContent).toBe('Cell');
		expect(target.querySelector('img, a, script, iframe, style')).toBeNull();
		expect(worker.terminate).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			'/api/files/docx-private/preview?v=2'
		);
		expect(
			new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')
		).toBe('Bearer private-token');
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	});

	it('keeps download and retries invalid documents with a fresh worker', async () => {
		const { target, ondownload } = mountPreview();
		const first = await nextWorker();
		first.complete({ kind: 'error' });
		await vi.waitFor(() =>
			expect(target.querySelector('[role="alert"]')).not.toBeNull()
		);
		const buttons = Array.from(target.querySelectorAll('button'));
		buttons.find((button) => button.textContent?.includes('Download'))?.click();
		expect(ondownload).toHaveBeenCalledOnce();
		expect(first.terminate).toHaveBeenCalledOnce();
		buttons
			.find((button) => button.textContent?.includes('Try again'))
			?.click();
		const second = await nextWorker(1);
		second.complete({
			kind: 'converted',
			hasErrors: false,
			html: '<p>Recovered</p>'
		});
		await vi.waitFor(() => expect(target.textContent).toContain('Recovered'));
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('aborts and terminates the active attempt on unmount', async () => {
		const { target } = mountPreview();
		const worker = await nextWorker();
		const lateMessage = worker.onmessage;
		const component = mounted.pop();

		if (!component) throw new Error('Missing component');
		await unmount(component);
		await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
		lateMessage?.(
			new MessageEvent('message', {
				data: { kind: 'converted', hasErrors: false, html: '<p>Stale</p>' }
			})
		);
		await tick();
		expect(target.textContent).not.toContain('Stale');
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	});

	it('clears content and cancels conversion when the file identity changes', async () => {
		let current = file;
		let update = () => {};

		const subscribe = createSubscriber((notify) => {
			update = notify;
		});

		const target = document.createElement('div');
		document.body.appendChild(target);

		const component = mount(DocxPreview, {
			target,
			props: {
				get file() {
					subscribe();

					return current;
				},
				token: 'private-token',
				ondownload: () => {}
			}
		});

		mounted.push(component);
		const first = await nextWorker();
		first.complete({
			kind: 'converted',
			hasErrors: false,
			html: '<p>Old version</p>'
		});
		await vi.waitFor(() => expect(target.textContent).toContain('Old version'));
		current = { ...file, version: 3 };
		update();
		const second = await nextWorker(1);
		expect(target.textContent).not.toContain('Old version');
		const lateMessage = second.onmessage;
		current = { ...file, id: 'different-docx' };
		update();
		const third = await nextWorker(2);
		expect(second.terminate).toHaveBeenCalledOnce();
		lateMessage?.(
			new MessageEvent('message', {
				data: {
					kind: 'converted',
					hasErrors: false,
					html: '<p>Stale version</p>'
				}
			})
		);
		third.complete({
			kind: 'converted',
			hasErrors: false,
			html: '<p>Current document</p>'
		});
		await vi.waitFor(() =>
			expect(target.textContent).toContain('Current document')
		);
		expect(target.textContent).not.toContain('Stale version');
	});

	it('leaves DOCX thumbnails as icons without fetching document bytes', async () => {
		const observe = vi.fn();
		vi.stubGlobal(
			'IntersectionObserver',
			class {
				constructor(
					private callback: (entries: { isIntersecting: boolean }[]) => void
				) {}
				observe() {
					observe();
					this.callback([{ isIntersecting: true }]);
				}
				unobserve() {}
				disconnect() {}
			}
		);
		const target = document.createElement('div');
		document.body.appendChild(target);
		mounted.push(
			mount(FileThumb, {
				target,
				props: {
					file,
					token: 'private-token',
					contentOrigin: 'https://content.example'
				}
			})
		);
		await vi.waitFor(() => expect(observe).toHaveBeenCalled());
		expect(target.textContent).toContain('DOCX');
		expect(fetchMock).not.toHaveBeenCalled();
		expect(workers).toHaveLength(0);
	});
});

describe('DOCX attempt admission and cancellation', () => {
	const load = () =>
		loadDocxPreview({
			token: 'token',
			id: 'file',
			version: 1,
			signal: new AbortController().signal
		});

	it('cancels an in-progress byte stream before conversion on abort', async () => {
		const cancel = vi.fn();
		fetchMock.mockImplementationOnce(
			async () =>
				new Response(new ReadableStream({ cancel }), {
					headers: { 'X-Adrive-Preview-Kind': 'docx' }
				})
		);
		const controller = new AbortController();

		const pending = loadDocxPreview({
			token: 'token',
			id: 'pending-input',
			version: 1,
			signal: controller.signal
		});

		const assertion = expect(pending).rejects.toThrow();
		await tick();
		controller.abort();
		await assertion;
		expect(cancel).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		expect(workers).toHaveLength(0);
	});

	it('terminates hung conversion after the conversion timeout', async () => {
		vi.useFakeTimers();
		const pending = load();

		const assertion = expect(pending).rejects.toThrow(
			'This document could not be previewed'
		);

		await vi.advanceTimersByTimeAsync(0);
		expect(workers).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(docxConversionTimeoutMs);
		await assertion;
		expect(workers[0]?.terminate).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	});

	it.each(['onerror', 'onmessageerror'] as const)(
		'terminates on worker %s',
		async (event) => {
			const pending = load();
			const assertion = expect(pending).rejects.toThrow();
			const worker = await nextWorker();
			worker[event]?.();
			await assertion;
			expect(worker.terminate).toHaveBeenCalledOnce();
		}
	);

	it('rejects incorrect kind headers and excessive input before starting a worker', async () => {
		const cancel = vi.fn();
		fetchMock.mockImplementationOnce(
			async () =>
				new Response(new ReadableStream({ cancel }), {
					headers: { 'X-Adrive-Preview-Kind': 'text' }
				})
		);
		await expect(load()).rejects.toThrow();
		expect(cancel).toHaveBeenCalledOnce();
		fetchMock.mockImplementationOnce(
			async () =>
				new Response(new Uint8Array(maxDocxPreviewBytes + 1), {
					headers: { 'X-Adrive-Preview-Kind': 'docx' }
				})
		);
		await expect(load()).rejects.toThrow();
		expect(workers).toHaveLength(0);
	});

	it('rejects excessive worker output and always releases the worker', async () => {
		const pending = load();
		const assertion = expect(pending).rejects.toThrow();
		const worker = await nextWorker();
		worker.complete({
			kind: 'converted',
			hasErrors: false,
			html: 'é'.repeat(maxDocxOutputBytes / 2 + 1)
		});
		await assertion;
		expect(worker.terminate).toHaveBeenCalledOnce();
	});
});
