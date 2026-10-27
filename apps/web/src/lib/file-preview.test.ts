import { describe, expect, it } from 'vitest';
import { maxPreviewBytes, previewKind } from './file-preview';

describe('file preview policy', () => {
	it('recognizes DOCX documents without treating their ZIP content as text', () => {
		expect(
			previewKind(
				'findings.docx',
				'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
			)
		).toBe('docx');
		expect(previewKind('findings.docx', 'application/octet-stream')).toBe(
			'docx'
		);
	});

	it('normalizes DOCX MIME and limits extension fallback to generic uploads', () => {
		expect(
			previewKind(
				'upload',
				' Application/Vnd.Openxmlformats-officedocument.Wordprocessingml.Document; charset=binary'
			)
		).toBe('docx');

		for (const type of [
			'',
			'application/zip',
			'application/x-zip-compressed'
		]) {
			expect(previewKind('FINDINGS.DOCX', type)).toBe('docx');
		}

		expect(previewKind('findings.docx', 'text/plain')).toBe('text');
		expect(previewKind('findings.docx', 'application/xml')).toBe('text');
		expect(previewKind('findings.docx', 'image/png')).toBeNull();
		expect(previewKind('findings.doc', 'application/msword')).toBeNull();
		expect(
			previewKind(
				'findings.xlsx',
				'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
			)
		).toBeNull();
	});

	it('recognizes Markdown even when an upload used a generic content type', () => {
		expect(previewKind('notes.md', 'application/octet-stream')).toBe(
			'markdown'
		);
		expect(previewKind('notes.txt', 'text/plain; charset=utf-8')).toBe('text');
	});

	it('does not treat binary files as text', () => {
		expect(previewKind('photo.png', 'image/png')).toBeNull();
		expect(maxPreviewBytes).toBe(1024 * 1024);
	});
});
