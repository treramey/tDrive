// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { build } from 'vite';
import { projectDocx, type DocxWorkerResult } from './docx-preview';
import { maxDocxOutputBytes, maxDocxPreviewBytes } from '$lib/file-preview';

let workerCode = '';

beforeAll(async () => {
	const output = await build({
		configFile: false,
		logLevel: 'silent',
		resolve: { alias: { $lib: resolve('src/lib') } },
		build: {
			write: false,
			lib: {
				entry: resolve('src/lib/dashboard/docx.worker.ts'),
				name: 'DocxWorker',
				formats: ['iife']
			}
		}
	});
	for (const bundle of Array.isArray(output) ? output : [output]) {
		if (!('output' in bundle)) throw new Error('Expected worker bundle');
		for (const chunk of bundle.output) {
			if (chunk.type === 'chunk' && chunk.isEntry) workerCode = chunk.code;
		}
	}
	if (!workerCode) throw new Error('Missing worker bundle');
});

const convert = async (bytes: ArrayBuffer): Promise<DocxWorkerResult> => {
	return new Promise((resolve) => {
		const worker = {
			onmessage: (_event: { data: ArrayBuffer }) => {},
			postMessage: resolve
		};
		runInNewContext(
			'self = globalThis;\n' + workerCode,
			Object.assign(worker, {
				importScripts: () => {},
				ArrayBuffer,
				Uint8Array,
				TextEncoder,
				TextDecoder,
				setTimeout,
				clearTimeout,
				setImmediate,
				clearImmediate,
				console
			})
		);
		worker.onmessage({ data: bytes });
	});
};

describe('browser DOCX worker with real Mammoth', () => {
	it('preserves headings, paragraphs, lists and tables while ignoring embedded style maps and unreadable images', async () => {
		const fixture = await readFile(
			resolve('src/lib/dashboard/fixtures/preview.docx')
		);
		const result = await convert(Uint8Array.from(fixture).buffer);
		expect(result.kind).toBe('converted');
		if (result.kind !== 'converted') throw new Error('Conversion failed');
		expect(result.hasErrors).toBe(false);
		expect(projectDocx(result.html)).toEqual([
			{ kind: 'heading', level: 1, text: 'Quarterly findings' },
			{ kind: 'paragraph', text: 'Private report & notes.' },
			{
				kind: 'list',
				ordered: false,
				items: ['First finding', 'Second finding']
			},
			{ kind: 'table', rows: [['Region', 'West']] },
			{ kind: 'paragraph', text: 'Read the source' }
		]);
	});

	it('rejects invalid and truncated ZIP files', async () => {
		expect(
			await convert(new TextEncoder().encode('not a document').buffer)
		).toEqual({ kind: 'error' });
		const fixture = await readFile(
			resolve('src/lib/dashboard/fixtures/preview.docx')
		);
		expect(
			await convert(Uint8Array.from(fixture.subarray(0, 100)).buffer)
		).toEqual({ kind: 'error' });
	});

	it('rejects compressed input over the admission limit', async () => {
		expect(await convert(new ArrayBuffer(maxDocxPreviewBytes + 1))).toEqual({
			kind: 'error'
		});
	});

	it('rejects a small compressed DOCX whose converted output exceeds the limit', async () => {
		const fixture = await readFile(
			resolve('src/lib/dashboard/fixtures/oversized-output.docx')
		);
		expect(await convert(Uint8Array.from(fixture).buffer)).toEqual({
			kind: 'error'
		});
	});
});

describe('text-only document blocks', () => {
	it('drops markup, executable content, URLs and document styles', () => {
		expect(
			projectDocx(
				'<h2 style="color:red" onclick="alert(1)">Heading</h2><p>Hello <a href="javascript:alert(1)">source</a><img src="https://example.com/pixel"><script>alert(1)</script><style>p{display:none}</style><br>&lt;img onerror=alert(1)&gt;</p>'
			)
		).toEqual([
			{ kind: 'heading', level: 2, text: 'Heading' },
			{ kind: 'paragraph', text: 'Hello source\n<img onerror=alert(1)>' }
		]);
	});

	it('does not duplicate nested list or table text', () => {
		expect(
			projectDocx(
				'<ul><li>Outer<ul><li>Inner</li></ul><table><tr><td>Cell</td></tr></table></li></ul><table><tr><td>A<table><tr><td>B</td></tr></table></td></tr></table>'
			)
		).toEqual([
			{ kind: 'list', ordered: false, items: ['Outer'] },
			{ kind: 'list', ordered: false, items: ['Inner'] },
			{ kind: 'table', rows: [['Cell']] },
			{ kind: 'table', rows: [['AB']] }
		]);
	});

	it('accepts an empty document and rejects excessive UTF-8 output', () => {
		expect(projectDocx('')).toEqual([]);
		expect(() => projectDocx('é'.repeat(maxDocxOutputBytes / 2 + 1))).toThrow();
	});
});
