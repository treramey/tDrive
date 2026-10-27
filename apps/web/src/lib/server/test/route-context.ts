import { Schema } from 'effect';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { with_request_store } from '@sveltejs/kit/internal/server';

export const DASHBOARD_ORIGIN = 'http://localhost:5173';

const noopSpan: RequestEvent['tracing']['root'] = {
	spanContext: () => ({
		traceId: '00000000000000000000000000000000',
		spanId: '0000000000000000',
		traceFlags: 0
	}),
	setAttribute() {
		return this;
	},
	setAttributes() {
		return this;
	},
	addEvent() {
		return this;
	},
	addLink() {
		return this;
	},
	addLinks() {
		return this;
	},
	setStatus() {
		return this;
	},
	updateName() {
		return this;
	},
	end() {},
	isRecording: () => false,
	recordException() {}
};

class TestCookieStore implements Cookies {
	readonly jar = new Map<string, string>();
	get(name: string) {
		return this.jar.get(name);
	}
	getAll() {
		return [...this.jar].map(([name, value]) => ({ name, value }));
	}
	set(name: string, value: string) {
		this.jar.set(name, value);
	}
	delete(name: string) {
		this.jar.delete(name);
	}
	serialize(...args: Parameters<Cookies['serialize']>) {
		return `${args[0]}=${args[1]}`;
	}
}

const waitUntilQueue: Array<Promise<unknown>> = [];

export interface RouteTestContext {
	readonly env: Env;
	readonly cookies: TestCookieStore;
	readonly url: (path: string) => URL;
	readonly event: (input: {
		method?: string;
		path: string;
		body?: BodyInit | null;
		headers?: Record<string, string>;
		params?: Record<string, string>;
	}) => RequestEvent;
	readonly drainWaitUntil: () => Promise<void>;
}

export const call = async <E, R>(
	handler: (event: E) => R,
	event: RequestEvent
): Promise<Awaited<R>> => {
	// SAFETY: generated handlers specialize route params; the test event supplies those params for the route under test.
	const routeHandler = handler as (event: RequestEvent) => R;

	return await with_request_store({ event }, () => routeHandler(event));
};

export const createRouteContext = async (): Promise<RouteTestContext> => {
	const { getTestPlatform } = await import('./platform');
	const proxy = await getTestPlatform();
	const platformEnv = proxy.env;

	const env = {
		...platformEnv,
		PASSCODE: platformEnv.PASSCODE ?? 'tdrive-route-test-passcode'
	};

	const cookies = new TestCookieStore();

	const build = ({
		method = 'GET',
		path,
		body,
		headers = {},
		params = {}
	}: {
		method?: string;
		path: string;
		body?: BodyInit | null;
		headers?: Record<string, string>;
		params?: Record<string, string>;
	}): RequestEvent => {
		const url = new URL(path, DASHBOARD_ORIGIN);

		// Upload routes require Content-Length (quota checks); undici only
		// sets it for fixed-length bodies, so supply it for strings here.
		const withLength = !Schema.is(Schema.String)(body)
			? headers
			: {
					'content-length': String(new TextEncoder().encode(body).byteLength),
					...headers
				};

		const requestInit = {
			method,
			headers: {
				origin: DASHBOARD_ORIGIN,
				...withLength
			},
			body: body ?? undefined,
			duplex: body instanceof ReadableStream ? 'half' : undefined
		} satisfies RequestInit & { duplex: 'half' | undefined };

		const request = new Request(url, requestInit);

		const event = {
			isRemoteRequest: false,
			tracing: { enabled: false, root: noopSpan, current: noopSpan },
			cookies,
			getClientAddress: () => '127.0.0.1',
			params,
			platform: {
				env,
				ctx: {
					waitUntil: (promise: Promise<unknown>) => {
						waitUntilQueue.push(promise);
					},
					passThroughOnException: () => {},
					props: {},
					get exports(): ExecutionContext['exports'] {
						throw new Error('Worker exports are not used by route fixtures');
					},
					get tracing(): ExecutionContext['tracing'] {
						throw new Error('Worker tracing is not used by route fixtures');
					}
				},
				caches: globalThis.caches,
				cf: proxy.cf
			},
			request,
			url,
			isSubRequest: false,
			route: { id: null },
			setHeaders: () => {},
			isDataRequest: false,
			locals: {},
			fetch: globalThis.fetch
		} satisfies RequestEvent;

		return event;
	};

	return {
		env,
		cookies,
		url: (path) => new URL(path, DASHBOARD_ORIGIN),
		event: build,
		drainWaitUntil: async () => {
			await Promise.allSettled(waitUntilQueue.splice(0));
		}
	};
};
