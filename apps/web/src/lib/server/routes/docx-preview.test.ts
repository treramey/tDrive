import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMcpHandler } from 'agents/mcp/server';
import {
	docxMediaType,
	maxDocxPreviewBytes,
	maxPreviewBytes
} from '$lib/file-preview';
import { createTdriveMcpServer } from '../mcp/server';
import {
	call,
	createRouteContext,
	type RouteTestContext
} from '../test/route-context';
import { login, mutateFile, uploadFile } from '../test/helpers';

let context: RouteTestContext | undefined;

const setup = async () => {
	context ??= await createRouteContext();
	await login(context);

	return context;
};

const uploaded = z.object({
	file: z.object({ id: z.string(), version: z.number() })
});

const uploadDocx = async (
	ctx: RouteTestContext,
	bytes: Uint8Array = new Uint8Array([80, 75])
) => {
	const { PUT } = await import('../../../routes/api/files/+server');

	const response = await call(
		PUT,
		ctx.event({
			method: 'PUT',
			path: '/api/files',
			body: Uint8Array.from(bytes).buffer,
			headers: {
				'content-type': docxMediaType,
				'content-length': String(bytes.byteLength),
				'x-adrive-file-name': 'report.docx',
				'x-adrive-public': 'false'
			}
		})
	);

	expect(response.status).toBe(201);

	return uploaded.parse(await response.json()).file;
};

const preview = async (ctx: RouteTestContext, id: string, version = '1') => {
	const { GET } =
		await import('../../../routes/api/files/[id]/preview/+server');

	return call(
		GET,
		ctx.event({ path: `/api/files/${id}/preview?v=${version}`, params: { id } })
	);
};

describe('authenticated DOCX preview route', () => {
	it('streams full private DOCX bytes and preserves the requested version after replacement and trash', async () => {
		const ctx = await setup();

		const fixture = Uint8Array.from(
			await readFile(resolve('src/lib/dashboard/fixtures/preview.docx'))
		);

		const file = await uploadDocx(ctx, fixture);

		const { PUT } =
			await import('../../../routes/api/files/[id]/versions/+server');

		const replacement = await call(
			PUT,
			ctx.event({
				method: 'PUT',
				path: `/api/files/${file.id}/versions`,
				params: { id: file.id },
				body: 'replacement document',
				headers: { 'content-type': docxMediaType }
			})
		);

		expect(replacement.status).toBe(201);
		await mutateFile(ctx, file.id, { action: 'trash' });
		const response = await preview(ctx, file.id);
		expect(response.status).toBe(200);
		expect(response.headers.get('X-Adrive-Preview-Kind')).toBe('docx');
		expect(response.headers.get('Content-Type')).toBe(docxMediaType);
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixture);
		expect(await (await preview(ctx, file.id, '2')).text()).toBe(
			'replacement document'
		);
	});

	it('rejects unauthenticated access and invalid or missing versions', async () => {
		const ctx = await setup();
		const file = await uploadDocx(ctx);
		const session = ctx.cookies.get('__Host-adrive-session');
		ctx.cookies.delete('__Host-adrive-session');

		try {
			await expect(preview(ctx, file.id)).rejects.toMatchObject({
				status: 401
			});
		} finally {
			if (session) ctx.cookies.set('__Host-adrive-session', session);
		}

		await expect(preview(ctx, file.id, '0')).rejects.toMatchObject({
			status: 400
		});
		await expect(preview(ctx, file.id, '99')).rejects.toMatchObject({
			status: 404
		});
	});

	it('enforces both metadata and actual blob limits while allowing DOCX above the text limit', async () => {
		const ctx = await setup();
		const allowed = await uploadDocx(ctx, new Uint8Array(maxPreviewBytes + 1));
		const response = await preview(ctx, allowed.id);
		expect(response.status).toBe(200);
		expect((await response.arrayBuffer()).byteLength).toBe(maxPreviewBytes + 1);

		const excessive = await uploadDocx(
			ctx,
			new Uint8Array(maxDocxPreviewBytes + 1)
		);

		await expect(preview(ctx, excessive.id)).rejects.toMatchObject({
			status: 413
		});
		await ctx.env.DB.prepare(
			'UPDATE file_versions SET size_bytes = 1 WHERE file_id = ?'
		)
			.bind(excessive.id)
			.run();
		await expect(preview(ctx, excessive.id)).rejects.toMatchObject({
			status: 413
		});
	});

	it('preserves Markdown and textual MIME precedence and rejects unsupported binaries', async () => {
		const ctx = await setup();

		const markdown = await uploadFile(ctx, {
			name: 'notes.md',
			content: '# Notes',
			contentType: 'application/octet-stream'
		});

		const response = await preview(ctx, markdown.id);
		expect(response.headers.get('X-Adrive-Preview-Kind')).toBe('markdown');
		expect(await response.text()).toBe('# Notes');

		const textual = await uploadFile(ctx, {
			name: 'text.docx',
			content: 'plain text',
			contentType: 'text/plain'
		});

		const textResponse = await preview(ctx, textual.id);
		expect(textResponse.headers.get('X-Adrive-Preview-Kind')).toBe('text');
		expect(await textResponse.text()).toBe('plain text');

		const binary = await uploadFile(ctx, {
			name: 'data.zip',
			contentType: 'application/zip'
		});

		await expect(preview(ctx, binary.id)).rejects.toMatchObject({
			status: 400
		});

		const excessive = await uploadFile(ctx, {
			name: 'large.txt',
			content: 'x'.repeat(maxPreviewBytes + 1)
		});

		await expect(preview(ctx, excessive.id)).rejects.toMatchObject({
			status: 413
		});
	});

	it('omits DOCX binary text from MCP include_text while retaining text for Markdown', async () => {
		const ctx = await setup();
		const docx = await uploadDocx(ctx);

		const markdown = await uploadFile(ctx, {
			name: 'mcp-notes.md',
			content: '# MCP notes'
		});

		const event = ctx.event({ path: '/mcp' });

		if (!event.platform) throw new Error('Missing platform');
		const platform = event.platform;

		const handler = createMcpHandler(
			() =>
				createTdriveMcpServer({
					env: ctx.env,
					ctx: platform.ctx,
					credential: {
						credentialId: 'preview-test',
						kind: 'api-key',
						scope: 'read-only'
					}
				}),
			{
				route: '/mcp',
				responseMode: 'json',
				allowedHostnames: ['localhost'],
				allowedOriginHostnames: ['localhost']
			}
		);

		const resultSchema = z.object({
			result: z.object({
				content: z.array(
					z.object({ type: z.literal('text'), text: z.string() })
				)
			})
		});

		for (const file of [docx, markdown]) {
			const response = await handler(
				new Request('http://localhost:5173/mcp', {
					method: 'POST',
					headers: {
						Host: 'localhost:5173',
						Accept: 'application/json, text/event-stream',
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						method: 'tools/call',
						params: {
							name: 'get_file',
							arguments: { id: file.id, include_text: true }
						}
					})
				}),
				ctx.env,
				event.platform.ctx
			);

			expect(response.status).toBe(200);
			const body = await response.text();

			const payload = body.startsWith('event:')
				? body
						.split('\n')
						.find((line) => line.startsWith('data:'))
						?.slice(5)
				: body;

			if (!payload) throw new Error('Missing MCP response');
			const result = resultSchema.parse(JSON.parse(payload));
			const entry = result.result.content[0];

			if (!entry) throw new Error('Missing tool result');

			const value = z
				.object({ url: z.string(), text: z.string().optional() })
				.parse(JSON.parse(entry.text));

			if (file.id === docx.id) expect(value.text).toBeUndefined();
			else expect(value.text).toBe('# MCP notes');
		}
	});
});
