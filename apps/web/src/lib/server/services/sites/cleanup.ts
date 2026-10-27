import { Effect } from 'effect';
import type { SiteInternals } from './internals';
import type { SitesService } from './types';

export const cleanupOps = (
	internals: SiteInternals
): Pick<SitesService, 'sweepLifecycle'> => {
	const { sweepExpiredSessions, sweepPendingDeletes } = internals;

	return {
		sweepLifecycle: Effect.fn('Sites.sweepLifecycle')(function* (
			limit: number
		) {
			const expired = yield* sweepExpiredSessions(limit);
			const pending = yield* sweepPendingDeletes(limit);

			return expired + pending;
		})
	};
};
