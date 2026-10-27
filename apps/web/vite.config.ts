import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	test: {
		exclude: [
			'**/node_modules/**',
			'src/lib/server/routes/**',
			'**/*.svelte.test.ts'
		]
	}
});
