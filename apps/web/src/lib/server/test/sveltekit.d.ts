declare module '@sveltejs/kit/internal/server' {
	import type { RequestEvent } from '@sveltejs/kit';

	export function with_request_store<A>(
		store: { readonly event: RequestEvent },
		run: () => A
	): A;
}

declare module '*@sveltejs/kit/src/utils/url.js' {
	export function normalize_path(
		path: string,
		trailingSlash: 'always' | 'never' | 'ignore'
	): string;
}
