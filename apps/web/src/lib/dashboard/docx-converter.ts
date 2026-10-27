import { maxDocxOutputBytes, maxDocxPreviewBytes } from '$lib/file-preview';
import type { DocxWorkerResult } from './docx-preview';

export const convertDocx = async (
	bytes: ArrayBuffer
): Promise<DocxWorkerResult> => {
	try {
		if (bytes.byteLength > maxDocxPreviewBytes) return { kind: 'error' };
		const mammoth = await import('mammoth');
		const result = await mammoth.convertToHtml(
			{ arrayBuffer: bytes },
			{
				includeEmbeddedStyleMap: false,
				externalFileAccess: false,
				convertImage: mammoth.images.imgElement(async () => ({ src: '' }))
			}
		);
		if (
			new TextEncoder().encode(result.value).byteLength > maxDocxOutputBytes
		) {
			return { kind: 'error' };
		}
		return {
			kind: 'converted',
			html: result.value,
			hasErrors: result.messages.some((message) => message.type === 'error')
		};
	} catch {
		return { kind: 'error' };
	}
};
