import { Context } from 'effect';

export class Db extends Context.Service<Db, D1Database>()('app/Db') {}

export class Bucket extends Context.Service<Bucket, R2Bucket>()('app/Bucket') {}

export interface AuthGuardStoreService {
	readonly get: (key: string) => Promise<string | null>;
	readonly put: (
		key: string,
		value: string,
		options: { readonly expirationTtl: number }
	) => Promise<void>;
	readonly delete: (key: string) => Promise<void>;
}

export class AuthGuardStore extends Context.Service<
	AuthGuardStore,
	AuthGuardStoreService
>()('app/AuthGuardStore') {}
