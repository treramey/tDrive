<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import type { Passkey } from '@tdrive/shared';
	import { ApiError, BROWSER_SESSION } from '$lib/dashboard/api';
	import {
		enrollPasskey,
		listPasskeys,
		passkeyMessage,
		passkeysSupported,
		removePasskey
	} from '$lib/dashboard/passkeys';
	import { getDashboardSession } from '$lib/dashboard/session.svelte';
	import { formatDate } from '$lib/dashboard/format';
	import Button from '$lib/components/ui/Button.svelte';
	import Field from '$lib/components/ui/Field.svelte';

	const session = getDashboardSession();
	const controller = new AbortController();
	let passkeys = $state<ReadonlyArray<Passkey>>([]);
	let supported = $state(false);
	let loading = $state(true);
	let operation = $state<'idle' | 'adding' | 'removing'>('idle');
	let name = $state('');
	let passcode = $state('');
	let removalPasscode = $state('');
	let selected = $state<Passkey | null>(null);
	let error = $state('');
	let status = $state('');

	const reload = async () => {
		if (session.token !== BROWSER_SESSION) {
			loading = false;

			return;
		}

		try {
			passkeys = await listPasskeys(controller.signal);
		} catch (cause) {
			if (controller.signal.aborted) return;

			if (cause instanceof ApiError && cause.status === 401) {
				await session.restoreAfterRevocation();
			} else
				error =
					cause instanceof Error ? cause.message : 'Could not load passkeys';
		} finally {
			loading = false;
		}
	};

	onMount(() => {
		supported = passkeysSupported();
		void reload();
	});

	onDestroy(() => controller.abort());

	const add = async () => {
		if (operation !== 'idle') return;
		operation = 'adding';
		error = '';
		status = '';

		try {
			await enrollPasskey({ name, passcode }, controller.signal);
			name = '';
			status = 'Passkey added.';
		} catch (cause) {
			if (!controller.signal.aborted) error = passkeyMessage(cause);
		} finally {
			passcode = '';
			await reload();
			operation = 'idle';
		}
	};

	const remove = async () => {
		const target = selected;

		if (!target || operation !== 'idle') return;
		operation = 'removing';
		error = '';
		status = '';

		try {
			const result = await removePasskey({
				id: target.id,
				passcode: removalPasscode
			});

			selected = null;
			status = 'Passkey removed.';

			if (result.signedOut) {
				await session.restoreAfterRevocation();
				await goto('/');
			}
		} catch (cause) {
			error = passkeyMessage(cause);
		} finally {
			removalPasscode = '';
			await reload();
			operation = 'idle';
		}
	};
</script>

<section aria-labelledby="passkeys-title">
	<h2 id="passkeys-title" class="text-lg font-semibold text-zinc-950">
		Passkeys
	</h2>
	<p class="mt-1 text-sm text-zinc-500">
		Sign in with your fingerprint, face, or security key. Your passcode remains
		available for recovery.
	</p>
	{#if session.token !== BROWSER_SESSION}
		<p class="mt-4 text-sm text-zinc-600">
			Sign in with the passcode to manage passkeys.
		</p>
	{:else}
		{#if error}<p class="mt-4 text-sm text-red-700" role="alert">
				{error}
			</p>{/if}
		{#if status}<p class="mt-4 text-sm text-zinc-700" role="status">
				{status}
			</p>{/if}
		{#if loading}
			<p class="mt-4 text-sm text-zinc-500">Loading passkeys...</p>
		{:else if passkeys.length === 0}
			<p class="mt-4 text-sm text-zinc-500">
				No passkeys saved. Add one below to sign in without your passcode.
			</p>
		{:else}
			<ul class="mt-5 divide-y divide-zinc-100">
				{#each passkeys as passkey (passkey.id)}
					<li class="flex items-start justify-between gap-4 py-3">
						<div>
							<p class="text-sm font-medium text-zinc-900">
								{passkey.name}{#if passkey.currentSession}<span
										class="ml-2 text-xs text-zinc-500">This session</span
									>{/if}
							</p>
							<p class="mt-1 text-xs text-zinc-500">
								Added {formatDate(passkey.createdAt)} · Last used {passkey.lastUsedAt
									? formatDate(passkey.lastUsedAt)
									: 'Never'}
							</p>
							{#if passkey.backedUp}<p class="mt-1 text-xs text-zinc-500">
									Backed up by your passkey provider
								</p>{/if}
						</div>
						<Button
							variant="danger"
							disabled={operation !== 'idle'}
							aria-label={`Remove ${passkey.name}`}
							onclick={() => {
								selected = passkey;
								removalPasscode = '';
								error = '';
								status = '';
							}}>Remove</Button
						>
					</li>
				{/each}
			</ul>
		{/if}
		{#if selected}
			<form
				class="mt-4 space-y-4 rounded-lg border border-zinc-200 p-4"
				onsubmit={(event) => {
					event.preventDefault();
					void remove();
				}}
			>
				<h3 class="text-sm font-semibold text-zinc-900">
					Remove {selected.name}?
				</h3>
				<p class="text-sm text-zinc-600">
					Sessions using this passkey will end.{selected.currentSession
						? ' This includes your current session.'
						: ''}{passkeys.length === 1
						? ' This is your last passkey. You can still sign in with the passcode.'
						: ''}
				</p>
				<Field
					id="remove-passkey-passcode"
					label="Current passcode to remove"
					type="password"
					autocomplete="current-password"
					bind:value={removalPasscode}
					required
					disabled={operation !== 'idle'}
				/>
				<div class="flex gap-2">
					<Button
						type="submit"
						variant="danger"
						disabled={operation !== 'idle' || !removalPasscode}
						>{operation === 'removing'
							? 'Removing...'
							: 'Remove passkey'}</Button
					>
					<Button
						variant="secondary"
						disabled={operation !== 'idle'}
						onclick={() => {
							selected = null;
							removalPasscode = '';
						}}>Cancel</Button
					>
				</div>
			</form>
		{:else if supported && passkeys.length < 8}
			<form
				class="mt-5 max-w-xl space-y-4"
				onsubmit={(event) => {
					event.preventDefault();
					void add();
				}}
			>
				<Field
					id="passkey-name"
					label="Passkey name"
					placeholder="My laptop"
					autocomplete="off"
					maxlength={80}
					bind:value={name}
					required
					disabled={operation !== 'idle'}
				/>
				<Field
					id="add-passkey-passcode"
					label="Current passcode to add"
					type="password"
					autocomplete="current-password"
					bind:value={passcode}
					required
					disabled={operation !== 'idle'}
				/>
				<Button
					type="submit"
					disabled={operation !== 'idle' ||
						loading ||
						!name.trim() ||
						!passcode}
					>{operation === 'adding'
						? 'Waiting for your passkey...'
						: 'Add passkey'}</Button
				>
			</form>
		{:else if !supported}
			<p class="mt-4 text-sm text-zinc-500">
				Passkeys require a supported browser on HTTPS or localhost. Use the
				passcode.
			</p>
		{:else}
			<p class="mt-4 text-sm text-zinc-500">
				You have 8 passkeys. Remove one before adding another.
			</p>
		{/if}
		{#if error && !loading}<Button
				variant="ghost"
				class="mt-2"
				disabled={operation !== 'idle'}
				onclick={() => {
					error = '';
					void reload();
				}}>Reload passkeys</Button
			>{/if}
	{/if}
</section>
