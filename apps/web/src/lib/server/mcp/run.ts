import { Cause, Effect, Exit, Match } from 'effect';
import { isAppError, runWorkerProgram, type AppServices } from '../edge';
import type { AppError } from '../errors';
import { requestLayer } from '../layer';
import { Indexing } from '../services/indexing';

export type McpRunSuccess<A> = { readonly ok: true; readonly value: A };

export type McpRunFailure = {
	readonly ok: false;
	readonly message: string;
	readonly status: number;
};

export type McpRunResult<A> = McpRunSuccess<A> | McpRunFailure;

export const failureFromAppError = (failure: AppError): McpRunFailure => {
	return Match.value(failure).pipe(
		Match.tag('InvalidRequest', (value) => ({
			ok: false as const,
			message: value.message,
			status: value.status
		})),
		Match.tag('MisdirectedRequest', (value) => ({
			ok: false as const,
			message: value.message,
			status: 421
		})),
		Match.tag('Unauthorized', (value) => ({
			ok: false as const,
			message: value.message,
			status: 401
		})),
		Match.tag('NotFound', () => ({
			ok: false as const,
			message: 'Not found',
			status: 404
		})),
		Match.tag('StorageError', () => ({
			ok: false as const,
			message: 'Storage unavailable',
			status: 502
		})),
		Match.exhaustive
	);
};

export const failureFromCause = (
	cause: Cause.Cause<unknown>
): McpRunFailure => {
	const dieDefects = cause.reasons
		.filter(Cause.isDieReason)
		.map((reason) => reason.defect);

	if (dieDefects.some((defect) => !isAppError(defect))) {
		return { ok: false, message: 'Internal error', status: 500 };
	}

	const appDefect = dieDefects.find(isAppError);

	if (appDefect) return failureFromAppError(appDefect);

	for (const reason of cause.reasons) {
		if (!Cause.isFailReason(reason)) continue;

		if (!isAppError(reason.error)) continue;

		return failureFromAppError(reason.error);
	}

	return { ok: false, message: 'Internal error', status: 500 };
};

export const runMcp = async <A, E>(
	env: Env,
	program: Effect.Effect<A, E, AppServices>
): Promise<McpRunResult<A>> => {
	const exit = await Effect.runPromiseExit(
		program.pipe(Effect.provide(requestLayer(env)))
	);

	if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };

	return failureFromCause(exit.cause);
};

export const scheduleIndex = (
	env: Env,
	ctx: ExecutionContext,
	fileId: string
) => {
	ctx.waitUntil(
		runWorkerProgram(
			env,
			Effect.gen(function* () {
				const indexing = yield* Indexing;
				yield* indexing.process(fileId);
			})
		)
	);
};
