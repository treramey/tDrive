import { Schema } from 'effect';
import { createMcpHandler } from 'agents/mcp/server';
import { describe, expect, it } from 'vitest';
import { mcpAllowedHostnames } from './handler';
import {
	READ_TOOL_NAMES,
	WRITE_TOOL_NAMES,
	createTdriveMcpServer
} from './server';

// SAFETY: discovery requests only read DASHBOARD_ORIGIN; no storage tools execute in these protocol tests.
const env = {
	DASHBOARD_ORIGIN: 'https://drive.example.com'
} as Env;

// SAFETY: initialization and tools/list only use waitUntil; other Worker APIs are not invoked.
const ctx = {
	waitUntil: (promise: Promise<unknown>) => {
		void promise;
	},
	passThroughOnException: () => undefined,
	props: {}
} as ExecutionContext;

const parseRpcBody = async (response: Response) => {
	const text = await response.text();

	const payload = text.startsWith('event:')
		? text
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).trim())
				.find((line) => line.startsWith('{'))
		: text;

	if (!payload) throw new Error(`MCP response had no JSON payload: ${text}`);

	return Schema.decodeUnknownSync(
		Schema.Struct({
			result: Schema.optional(
				Schema.Struct({
					tools: Schema.optional(
						Schema.Array(Schema.Struct({ name: Schema.String }))
					),
					serverInfo: Schema.optional(Schema.Struct({ name: Schema.String }))
				})
			),
			error: Schema.optional(Schema.Struct({ message: Schema.String }))
		})
	)(JSON.parse(payload));
};

const rpc = async <A>(scope: 'read-only' | 'read-write', body: A) => {
	const handler = createMcpHandler(
		() =>
			createTdriveMcpServer({
				env,
				ctx,
				credential: {
					credentialId: 'key-1',
					kind: 'api-key',
					scope
				}
			}),
		{
			route: '/mcp',
			responseMode: 'json',
			allowedHostnames: mcpAllowedHostnames(env.DASHBOARD_ORIGIN),
			allowedOriginHostnames: mcpAllowedHostnames(env.DASHBOARD_ORIGIN)
		}
	);

	const response = await handler(
		new Request('https://drive.example.com/mcp', {
			method: 'POST',
			headers: {
				Host: 'drive.example.com',
				Accept: 'application/json, text/event-stream',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body)
		}),
		env,
		ctx
	);

	return {
		status: response.status,
		body: await parseRpcBody(response)
	};
};

describe('MCP server factory', () => {
	it('initializes over streamable HTTP', async () => {
		const { status, body } = await rpc('read-only', {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2026-07-28',
				capabilities: {},
				clientInfo: { name: 'tdrive-test', version: '0.0.0' }
			}
		});

		expect(status).toBe(200);
		expect(body.error).toBeUndefined();
		expect(body.result?.serverInfo?.name).toBe('tdrive');
	});

	it('lists only read tools for a read-only key', async () => {
		const { body } = await rpc('read-only', {
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: {}
		});

		const names = (body.result?.tools ?? []).map((tool) => tool.name);
		expect(names.sort()).toEqual([...READ_TOOL_NAMES].sort());
		expect(
			names.some((name) => new Set<string>(WRITE_TOOL_NAMES).has(name))
		).toBe(false);
	});

	it('lists write tools for a read-write key', async () => {
		const { body } = await rpc('read-write', {
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/list',
			params: {}
		});

		const names = (body.result?.tools ?? []).map((tool) => tool.name);
		expect(names).toEqual(expect.arrayContaining([...READ_TOOL_NAMES]));
		expect(names).toEqual(expect.arrayContaining([...WRITE_TOOL_NAMES]));
	});
});
