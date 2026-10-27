import { Function, Option, Schema } from 'effect';

export const decodeRows = <A, I>(schema: Schema.Codec<A, I, never>) =>
	Function.flow(
		Schema.decodeUnknownOption(Schema.Array(schema)),
		Option.getOrElse(() => [])
	);
