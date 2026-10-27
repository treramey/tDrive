// Replaced by esbuild --define at release build time; running from
// source (strip-types) leaves it undefined and falls back to "dev".
declare const __TDRIVE_VERSION__: string | undefined;
export const CLI_VERSION =
	typeof __TDRIVE_VERSION__ === 'string' ? __TDRIVE_VERSION__ : 'dev';
