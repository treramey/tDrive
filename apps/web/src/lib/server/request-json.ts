import { Effect, Schema, Data } from 'effect';
import { InvalidRequest } from './errors';

interface BoundedJsonOptions {
	readonly maxBytes: number;
	readonly invalidLengthMessage: string;
	readonly invalidJsonMessage: string;
}

type BodyReadResult =
	| { readonly _tag: 'Success'; readonly bytes: Uint8Array }
	| { readonly _tag: 'TooLarge' }
	| { readonly _tag: 'ReadFailure' };

const BodyReadResult = Data.taggedEnum<BodyReadResult>();

const readBodyAtMost = async (
	request: Request,
	maxBytes: number
): Promise<BodyReadResult> => {
	if (request.body === null) {
		return BodyReadResult.Success({ bytes: new Uint8Array() });
	}

	let reader: ReadableStreamDefaultReader<Uint8Array>;

	try {
		reader = request.body.getReader();
	} catch {
		return BodyReadResult.ReadFailure();
	}

	const chunks: Array<Uint8Array> = [];
	let totalBytes = 0;

	try {
		while (true) {
			const next = await reader.read();

			if (next.done) break;

			totalBytes += next.value.byteLength;

			if (totalBytes > maxBytes) {
				try {
					await reader.cancel();
				} catch {
					// The size violation remains the primary request failure.
				}

				return BodyReadResult.TooLarge();
			}

			chunks.push(next.value);
		}
	} catch {
		return BodyReadResult.ReadFailure();
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// A disturbed stream is handled as a request failure above.
		}
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;

	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return BodyReadResult.Success({ bytes });
};

export const readBoundedJson = (
	request: Request,
	{ maxBytes, invalidLengthMessage, invalidJsonMessage }: BoundedJsonOptions
) =>
	Effect.gen(function* () {
		// A declared length is validated up front so oversized requests fail
		// before any bytes are read, but the header is not required: the
		// streaming reader below enforces maxBytes for chunked bodies too.
		const contentLengthHeader = request.headers.get('content-length');

		if (contentLengthHeader !== null) {
			const contentLength = Number(contentLengthHeader);

			if (
				!Number.isSafeInteger(contentLength) ||
				contentLength < 0 ||
				contentLength > maxBytes
			) {
				return yield* new InvalidRequest({
					status: contentLength > maxBytes ? 413 : 400,
					message: invalidLengthMessage
				});
			}
		}

		const body = yield* Effect.promise(() => readBodyAtMost(request, maxBytes));

		return yield* BodyReadResult.$match(body, {
			TooLarge: () =>
				Effect.fail(
					new InvalidRequest({ status: 413, message: invalidLengthMessage })
				),
			ReadFailure: () =>
				Effect.fail(
					new InvalidRequest({ status: 400, message: invalidJsonMessage })
				),
			Success: ({ bytes }) =>
				Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
					new TextDecoder().decode(bytes)
				).pipe(
					Effect.mapError(
						() =>
							new InvalidRequest({ status: 400, message: invalidJsonMessage })
					)
				)
		});
	});

export const DEFAULT_JSON_BODY_LIMIT = 16 * 1024;

export const decodeJson = <A, I>(
	request: Request,
	schema: Schema.Codec<A, I, never>,
	message: string,
	maxBytes: number = DEFAULT_JSON_BODY_LIMIT
) =>
	readBoundedJson(request, {
		maxBytes,
		invalidLengthMessage: message,
		invalidJsonMessage: message
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		Effect.mapError((cause) =>
			cause instanceof InvalidRequest
				? cause
				: new InvalidRequest({ status: 400, message })
		)
	);
