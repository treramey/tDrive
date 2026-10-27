import { FileDetailResponseSchema } from '@tdrive/shared';
import { Schema, Option } from 'effect';
import type { PageServerLoad } from './$types';

const readError = async (response: Response) => {
	try {
		const body = Schema.decodeUnknownOption(
			Schema.Struct({ message: Schema.String })
		)(await response.json());

		if (Option.isSome(body)) return body.value.message;
	} catch {
		// The status fallback below is enough for non-JSON failures.
	}

	return `Could not load the file (${response.status})`;
};

export const load: PageServerLoad = async ({ depends, fetch, params }) => {
	depends(`tdrive:file:${params.id}`);
	let response: Response;

	try {
		response = await fetch(`/api/files/${encodeURIComponent(params.id)}`);
	} catch {
		return {
			initialDetail: null,
			initialError: 'Could not load the file'
		};
	}

	if (response.status === 401) {
		return { initialDetail: null, initialError: '' };
	}

	if (!response.ok) {
		return { initialDetail: null, initialError: await readError(response) };
	}

	try {
		return {
			initialDetail: await Schema.decodeUnknownPromise(
				FileDetailResponseSchema
			)(await response.json()),
			initialError: ''
		};
	} catch {
		return {
			initialDetail: null,
			initialError: 'The server returned invalid file data'
		};
	}
};
