export const maxPreviewBytes = 1024 * 1024;
export const maxDocxPreviewBytes = 5 * 1024 * 1024;
export const maxDocxOutputBytes = 2 * 1024 * 1024;
export const docxConversionTimeoutMs = 10_000;
export const docxMediaType =
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type PreviewKind = 'markdown' | 'text' | 'docx';

const markdownExtensions = /\.(?:md|markdown|mdown|mkd)$/i;
const textExtensions =
	/\.(?:txt|csv|tsv|json|jsonl|xml|ya?ml|toml|ini|log|css|js|mjs|cjs|ts|mts|cts|jsx|tsx|svelte|html?|svg|sh|zsh|bash|fish|py|rb|rs|go|java|kt|swift|sql)$/i;

export const previewKind = (
	displayName: string,
	contentType: string
): PreviewKind | null => {
	const normalizedType = contentType.split(';', 1)[0]?.trim().toLowerCase();
	if (
		normalizedType === docxMediaType ||
		(/\.docx$/i.test(displayName) &&
			(!normalizedType ||
				normalizedType === 'application/octet-stream' ||
				normalizedType === 'application/zip' ||
				normalizedType === 'application/x-zip-compressed'))
	) {
		return 'docx';
	}
	if (
		normalizedType === 'text/markdown' ||
		normalizedType === 'text/x-markdown' ||
		markdownExtensions.test(displayName)
	) {
		return 'markdown';
	}
	if (
		normalizedType?.startsWith('text/') ||
		normalizedType === 'application/json' ||
		normalizedType === 'application/xml' ||
		textExtensions.test(displayName)
	) {
		return 'text';
	}
	return null;
};
