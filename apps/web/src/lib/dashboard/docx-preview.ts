import { z } from 'zod';
import {
	docxConversionTimeoutMs,
	maxDocxOutputBytes,
	maxDocxPreviewBytes
} from '$lib/file-preview';
import { ApiError, request } from './api';

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type DocumentBlock =
	| { kind: 'heading'; level: HeadingLevel; text: string }
	| { kind: 'paragraph'; text: string }
	| { kind: 'list'; ordered: boolean; items: string[] }
	| { kind: 'table'; rows: string[][] };

const headingLevels = new Map<string, HeadingLevel>([
	['H1', 1],
	['H2', 2],
	['H3', 3],
	['H4', 4],
	['H5', 5],
	['H6', 6]
]);

const workerResult = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('error') }),
	z.object({
		kind: z.literal('converted'),
		html: z.string().max(maxDocxOutputBytes),
		hasErrors: z.boolean()
	})
]);

export type DocxWorkerResult = z.infer<typeof workerResult>;

export class DocxPreviewError extends Error {
	constructor() {
		super('This document could not be previewed');
		this.name = 'DocxPreviewError';
	}
}

export const projectDocx = (html: string): DocumentBlock[] => {
	if (new TextEncoder().encode(html).byteLength > maxDocxOutputBytes) {
		throw new DocxPreviewError();
	}

	const document = new DOMParser().parseFromString(html, 'text/html');

	for (const node of document.querySelectorAll(
		'script, style, template, iframe, object, embed, img, link, meta'
	)) {
		node.remove();
	}

	const blocks: DocumentBlock[] = [];

	const text = (node: Node): string => {
		if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';

		if (node instanceof Element && node.tagName === 'BR') return '\n';
		const value = Array.from(node.childNodes, text).join('');

		return node instanceof Element && node.tagName === 'P'
			? `${value}\n`
			: value;
	};

	const walk = (node: Element) => {
		const level = headingLevels.get(node.tagName);

		if (level !== undefined) {
			const value = text(node).trim();

			if (value) blocks.push({ kind: 'heading', level, text: value });
		} else if (node.tagName === 'P') {
			const value = text(node).trim();

			if (value) blocks.push({ kind: 'paragraph', text: value });
		} else if (node.tagName === 'UL' || node.tagName === 'OL') {
			const items: string[] = [];
			const nested: Element[] = [];

			for (const item of node.children) {
				if (item.tagName !== 'LI') continue;
				const copy = item.cloneNode(true);

				if (!(copy instanceof Element)) continue;

				for (const child of copy.querySelectorAll('ul, ol, table'))
					child.remove();
				const itemText = text(copy).trim();

				if (itemText) items.push(itemText);

				for (const child of item.querySelectorAll('ul, ol, table')) {
					if (child.parentElement?.closest('ul, ol, table') === node)
						nested.push(child);
				}
			}

			if (items.length)
				blocks.push({ kind: 'list', ordered: node.tagName === 'OL', items });

			for (const child of nested) walk(child);
		} else if (node.tagName === 'TABLE') {
			const rows = Array.from(node.querySelectorAll('tr'))
				.filter((row) => row.closest('table') === node)
				.map((row) =>
					Array.from(row.children)
						.filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
						.map((cell) => text(cell).trim())
				);

			if (rows.length) blocks.push({ kind: 'table', rows });
		} else {
			for (const child of node.children) walk(child);
		}
	};

	walk(document.body);

	return blocks;
};

export const loadDocxPreview = async ({
	token,
	id,
	version,
	signal
}: {
	token: string;
	id: string;
	version: number;
	signal: AbortSignal;
}): Promise<DocumentBlock[]> => {
	const controller = new AbortController();
	let worker: Worker | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

	const abort = () => {
		controller.abort(signal.reason);
		void reader?.cancel().catch(() => {});
	};

	signal.addEventListener('abort', abort, { once: true });

	try {
		signal.throwIfAborted();

		const response = await request(
			`/api/files/${encodeURIComponent(id)}/preview?v=${version}`,
			token,
			{ signal: controller.signal }
		);

		reader = response.body?.getReader();

		if (
			response.headers.get('X-Adrive-Preview-Kind') !== 'docx' ||
			Number(response.headers.get('Content-Length')) > maxDocxPreviewBytes ||
			!reader
		) {
			throw new DocxPreviewError();
		}

		const chunks: Uint8Array[] = [];
		let size = 0;

		while (true) {
			controller.signal.throwIfAborted();
			const { done, value } = await reader.read();

			if (done) break;
			size += value.byteLength;

			if (size > maxDocxPreviewBytes) throw new DocxPreviewError();
			chunks.push(value);
		}

		const bytes = new Uint8Array(size);
		let offset = 0;

		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}

		controller.signal.throwIfAborted();

		const attempt = new Worker(new URL('./docx.worker.ts', import.meta.url), {
			type: 'module'
		});

		worker = attempt;

		const result = await new Promise<DocxWorkerResult>((resolve, reject) => {
			const fail = () => reject(new DocxPreviewError());
			controller.signal.addEventListener('abort', fail, { once: true });
			timer = setTimeout(fail, docxConversionTimeoutMs);
			attempt.onerror = fail;
			attempt.onmessageerror = fail;
			attempt.onmessage = (event: MessageEvent<unknown>) => {
				const parsed = workerResult.safeParse(event.data);

				if (parsed.success) resolve(parsed.data);
				else fail();
			};

			attempt.postMessage(bytes.buffer, [bytes.buffer]);
		});

		controller.signal.throwIfAborted();

		if (result.kind === 'error') throw new DocxPreviewError();
		const blocks = projectDocx(result.html);

		if (result.hasErrors && blocks.length === 0) throw new DocxPreviewError();

		return blocks;
	} catch (cause) {
		controller.signal.throwIfAborted();

		if (cause instanceof ApiError) throw cause;
		throw new DocxPreviewError();
	} finally {
		worker?.terminate();

		if (timer !== undefined) clearTimeout(timer);
		controller.abort();
		await reader?.cancel().catch(() => {});
		signal.removeEventListener('abort', abort);
	}
};
