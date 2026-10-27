import type { UserConfig } from 'vite-plus';

const toolingIgnores = [
	'.agent/**',
	'.agents/**',
	'.claude/**',
	'.codex/**',
	'.continue/**',
	'.cursor/**',
	'.gemini/**',
	'.opencode/**',
	'.pi/**',
	'.roo/**',
	'.windsurf/**',
	'tools/oxlint/anti-slop/**',
	'apps/web/worker-configuration.d.ts'
];

// A plain config also works with the workspace's existing Vitest 4 suites.
export default {
	fmt: {
		useTabs: true,
		singleQuote: true,
		trailingComma: 'none',
		printWidth: 80,
		sortPackageJson: false,
		svelte: true,
		ignorePatterns: [
			...toolingIgnores,
			'**/node_modules/**',
			'**/.svelte-kit/**',
			'**/.svelte-check/**',
			'**/.wrangler/**',
			'**/dist/**',
			'**/build/**',
			'**/coverage/**',
			'bun.lock',
			'**/_headers'
		]
	},
	lint: {
		ignorePatterns: toolingIgnores,
		jsPlugins: [
			{
				name: 'anti-slop',
				specifier: './tools/oxlint/anti-slop/index.ts'
			},
			{
				name: 'anti-slop-effect',
				specifier: './tools/oxlint/anti-slop/effect/index.ts'
			}
		],
		rules: {
			'oxc/no-accumulating-spread': 'error',
			'anti-slop/no-array-filter-map': 'error',
			'anti-slop/no-reduce-accumulator-copy': 'error',
			'anti-slop/no-chained-type-assertions': 'error',
			'anti-slop/no-conditional-empty-object-spread': 'error',
			'anti-slop/no-known-value-widening': 'error',
			'anti-slop/no-module-mocking': 'error',
			'anti-slop/no-object-parameters': 'error',
			'anti-slop/no-reflect-apply': 'error',
			'anti-slop/no-reflect-get': 'error',
			'anti-slop/no-runtime-typeof': 'error',
			'anti-slop/no-shape-in-symbol-names': 'error',
			'anti-slop/no-unknown-parameters': 'error',
			'anti-slop/no-unknown-returns': 'error',
			'anti-slop/no-unknown-type-aliases': 'error',
			'anti-slop/no-unsafe-dictionary-type': 'error',
			'anti-slop/no-widen-then-assert': 'error',
			'anti-slop/require-readable-spacing': 'error',
			'anti-slop/require-safety-comment-for-type-assertion': 'error',
			'anti-slop-effect/no-manual-effect-error-tag': 'error',
			'anti-slop-effect/no-manual-tag-comparison': 'error',
			'anti-slop-effect/no-manual-tagged-construction': 'error',
			'anti-slop-effect/no-service-constructor-imports': 'error',
			'anti-slop-effect/prefer-effect-match': 'error'
		}
	}
} satisfies UserConfig;
