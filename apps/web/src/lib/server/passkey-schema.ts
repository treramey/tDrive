import { Schema } from 'effect';

export const CeremonyIdSchema = Schema.String.check(
	Schema.isPattern(/^[0-9a-f]{32}$/)
).pipe(Schema.brand('CeremonyId'));

export const base64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');

export const unbase64url = (value: string) =>
	Uint8Array.from(
		atob(value.replaceAll('-', '+').replaceAll('_', '/')),
		(char) => char.charCodeAt(0)
	);

const EncodedBytes = Schema.String.check(
	Schema.makeFilter((value) => {
		if (
			!/^[A-Za-z0-9_-]+$/.test(value) ||
			value.length > 14000 ||
			value.length % 4 === 1
		)
			return false;
		return base64url(unbase64url(value)) === value;
	})
);

const CredentialFields = {
	id: EncodedBytes.check(Schema.isMaxLength(1400)),
	rawId: EncodedBytes.check(Schema.isMaxLength(1400)),
	type: Schema.Literal('public-key'),
	clientExtensionResults: Schema.Struct({})
};

export const PasskeyLoginSubmission = Schema.Struct({
	ceremonyId: CeremonyIdSchema,
	credential: Schema.Struct({
		...CredentialFields,
		response: Schema.Struct({
			clientDataJSON: EncodedBytes,
			authenticatorData: EncodedBytes,
			signature: EncodedBytes,
			userHandle: EncodedBytes
		})
	}).check(Schema.makeFilter((value) => value.id === value.rawId))
});

export const PasskeyEnrollSubmission = Schema.Struct({
	ceremonyId: CeremonyIdSchema,
	credential: Schema.Struct({
		...CredentialFields,
		response: Schema.Struct({
			clientDataJSON: EncodedBytes,
			attestationObject: EncodedBytes
		})
	}).check(Schema.makeFilter((value) => value.id === value.rawId))
});

export const ClientDataSchema = Schema.Struct({
	crossOrigin: Schema.optional(Schema.Boolean)
});
