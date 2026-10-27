import { Predicate } from 'effect';
import type {
	AuthenticationResponseJSON,
	RegistrationResponseJSON
} from '@simplewebauthn/server';

const encode = (value: Uint8Array) => Buffer.from(value).toString('base64url');

const decode = (value: string) =>
	new Uint8Array(Buffer.from(value, 'base64url'));

const text = (value: string) => new TextEncoder().encode(value);

const concat = (...parts: Uint8Array[]) => {
	const bytes = new Uint8Array(
		parts.reduce((sum, part) => sum + part.length, 0)
	);

	let offset = 0;

	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}

	return bytes;
};

const digest = async (value: Uint8Array) =>
	new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value)));

const uint = (value: number, major = 0) =>
	value < 24
		? Uint8Array.of(major * 32 + value)
		: value < 256
			? Uint8Array.of(major * 32 + 24, value)
			: Uint8Array.of(major * 32 + 25, value >> 8, value & 255);

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

const cbor = (value: Cbor): Uint8Array => {
	if (Predicate.isNumber(value))
		return value >= 0 ? uint(value) : uint(-1 - value, 1);

	if (Predicate.isString(value))
		return concat(uint(text(value).length, 3), text(value));

	if (value instanceof Uint8Array) return concat(uint(value.length, 2), value);

	return concat(
		uint(value.size, 5),
		...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])
	);
};

const der = (signature: Uint8Array) => {
	const integer = (bytes: Uint8Array) => {
		let start = 0;

		while (start < bytes.length - 1 && bytes[start] === 0) start++;
		let value = bytes.slice(start);

		if ((value[0] ?? 0) >= 128) value = concat(Uint8Array.of(0), value);

		return concat(Uint8Array.of(2, value.length), value);
	};

	const parts = concat(
		integer(signature.slice(0, 32)),
		integer(signature.slice(32))
	);

	return concat(Uint8Array.of(0x30, parts.length), parts);
};

export const softwareAuthenticator = async (
	algorithm: 'ES256' | 'RS256' = 'ES256'
) => {
	const keys =
		algorithm === 'ES256'
			? await crypto.subtle.generateKey(
					{ name: 'ECDSA', namedCurve: 'P-256' },
					true,
					['sign', 'verify']
				)
			: await crypto.subtle.generateKey(
					{
						name: 'RSASSA-PKCS1-v1_5',
						modulusLength: 2048,
						publicExponent: Uint8Array.of(1, 0, 1),
						hash: 'SHA-256'
					},
					true,
					['sign', 'verify']
				);

	const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);

	const field = (key: 'x' | 'y' | 'n' | 'e') => {
		const value = jwk[key];

		if (!value) throw new Error(`Missing ${key}`);

		return decode(value);
	};

	const cose =
		algorithm === 'ES256'
			? cbor(
					new Map<Cbor, Cbor>([
						[1, 2],
						[3, -7],
						[-1, 1],
						[-2, field('x')],
						[-3, field('y')]
					])
				)
			: cbor(
					new Map<Cbor, Cbor>([
						[1, 3],
						[3, -257],
						[-1, field('n')],
						[-2, field('e')]
					])
				);

	const idBytes = crypto.getRandomValues(new Uint8Array(32));
	const id = encode(idBytes);

	const sign = async (value: Uint8Array) => {
		const signature = new Uint8Array(
			await crypto.subtle.sign(
				algorithm === 'ES256'
					? { name: 'ECDSA', hash: 'SHA-256' }
					: 'RSASSA-PKCS1-v1_5',
				keys.privateKey,
				new Uint8Array(value)
			)
		);

		return algorithm === 'ES256' ? der(signature) : signature;
	};

	const authData = async (rp: string, flags: number, counter: number) => {
		const count = new Uint8Array(4);
		new DataView(count.buffer).setUint32(0, counter);

		return concat(await digest(text(rp)), Uint8Array.of(flags), count);
	};

	const clientData = (
		kind: 'create' | 'get',
		challenge: string,
		origin: string,
		crossOrigin = false
	) =>
		text(
			JSON.stringify({
				type: `webauthn.${kind}`,
				challenge,
				origin,
				crossOrigin
			})
		);

	return {
		id,
		register: async (input: {
			challenge: string;
			origin?: string;
			rp?: string;
			flags?: number;
			packed?: boolean;
		}): Promise<RegistrationResponseJSON> => {
			const client = clientData(
				'create',
				input.challenge,
				input.origin ?? 'http://localhost:5173'
			);

			const data = concat(
				await authData(input.rp ?? 'localhost', input.flags ?? 0x45, 0),
				new Uint8Array(16),
				Uint8Array.of(0, idBytes.length),
				idBytes,
				cose
			);

			const statement = input.packed
				? new Map<Cbor, Cbor>([
						['alg', algorithm === 'ES256' ? -7 : -257],
						['sig', await sign(concat(data, await digest(client)))]
					])
				: new Map<Cbor, Cbor>();

			return {
				id,
				rawId: id,
				type: 'public-key',
				clientExtensionResults: {},
				response: {
					clientDataJSON: encode(client),
					attestationObject: encode(
						cbor(
							new Map<Cbor, Cbor>([
								['fmt', input.packed ? 'packed' : 'none'],
								['authData', data],
								['attStmt', statement]
							])
						)
					)
				}
			};
		},
		assert: async (input: {
			challenge: string;
			userHandle: string;
			counter?: number;
			flags?: number;
			origin?: string;
			rp?: string;
			crossOrigin?: boolean;
			badSignature?: boolean;
		}): Promise<AuthenticationResponseJSON> => {
			const client = clientData(
				'get',
				input.challenge,
				input.origin ?? 'http://localhost:5173',
				input.crossOrigin
			);

			const data = await authData(
				input.rp ?? 'localhost',
				input.flags ?? 5,
				input.counter ?? 0
			);

			const signature = await sign(concat(data, await digest(client)));

			if (input.badSignature)
				signature[signature.length - 1] = (signature.at(-1) ?? 0) ^ 255;

			return {
				id,
				rawId: id,
				type: 'public-key',
				clientExtensionResults: {},
				response: {
					clientDataJSON: encode(client),
					authenticatorData: encode(data),
					signature: encode(signature),
					userHandle: input.userHandle
				}
			};
		}
	};
};
