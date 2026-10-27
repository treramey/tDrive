<script lang="ts">
	import type { DashboardFile } from '@tdrive/shared';
	import {
		loadDocxPreview,
		type DocumentBlock
	} from '$lib/dashboard/docx-preview';
	import Button from '$lib/components/ui/Button.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';

	let {
		file,
		token,
		ondownload
	}: {
		file: DashboardFile;
		token: string;
		ondownload: () => void;
	} = $props();

	type PreviewState =
		| { kind: 'loading' }
		| { kind: 'ready'; blocks: DocumentBlock[] }
		| { kind: 'error'; message: string };
	let previewState = $state<PreviewState>({ kind: 'loading' });
	let retry = $state(0);

	$effect(() => {
		const input = { token, id: file.id, version: file.version };
		void file.contentType;
		void file.displayName;
		void file.deletedAt;
		void file.expiresAt;
		void file.public;
		void retry;
		const controller = new AbortController();
		previewState = { kind: 'loading' };
		void loadDocxPreview({ ...input, signal: controller.signal })
			.then((blocks) => {
				if (!controller.signal.aborted)
					previewState = { kind: 'ready', blocks };
			})
			.catch((cause: unknown) => {
				if (controller.signal.aborted) return;
				previewState = {
					kind: 'error',
					message:
						cause instanceof Error
							? cause.message
							: 'This document could not be previewed'
				};
			});
		return () => controller.abort();
	});
</script>

{#if previewState.kind === 'loading'}
	<div
		class="min-h-[28rem] animate-pulse p-8 text-sm text-zinc-500"
		role="status"
	>
		Loading document preview...
	</div>
{:else if previewState.kind === 'error'}
	<div
		class="flex min-h-[28rem] flex-col items-center justify-center gap-4 p-8 text-center"
		role="alert"
	>
		<p class="text-sm text-red-700">{previewState.message}</p>
		<Button variant="secondary" onclick={() => (retry += 1)}>Try again</Button>
		<Button onclick={ondownload}><Icon name="download" />Download</Button>
	</div>
{:else}
	<article
		class="space-y-4 overflow-x-auto p-6 text-sm leading-7 text-zinc-800 sm:p-10"
		aria-label="Document content"
	>
		{#each previewState.blocks as block}
			{#if block.kind === 'heading'}
				<svelte:element
					this={`h${block.level}`}
					class="whitespace-pre-wrap text-xl font-semibold"
					>{block.text}</svelte:element
				>
			{:else if block.kind === 'paragraph'}
				<p class="whitespace-pre-wrap">{block.text}</p>
			{:else if block.kind === 'list'}
				{#if block.ordered}
					<ol class="list-decimal pl-6">
						{#each block.items as item}<li class="whitespace-pre-wrap">
								{item}
							</li>{/each}
					</ol>
				{:else}
					<ul class="list-disc pl-6">
						{#each block.items as item}<li class="whitespace-pre-wrap">
								{item}
							</li>{/each}
					</ul>
				{/if}
			{:else if block.kind === 'table'}
				<table class="w-full border-collapse text-left">
					<tbody
						>{#each block.rows as row}<tr
								>{#each row as cell}<td
										class="border border-zinc-200 px-3 py-2 whitespace-pre-wrap"
										>{cell}</td
									>{/each}</tr
							>{/each}</tbody
					>
				</table>
			{/if}
		{/each}
		{#if previewState.blocks.length === 0}<p class="text-zinc-500">
				This document has no text to preview.
			</p>{/if}
	</article>
{/if}
