import { config } from '../config';
import { IClassClient } from '../adapters/iclass/IClassClient';
import { PrismaClosedServiceOrderRepository } from '../adapters/prisma/PrismaClosedServiceOrderRepository';
import { PrismaIClassResultCodeRepository } from '../adapters/prisma/PrismaIClassResultCodeRepository';
import { PrismaSchedulingRepository } from '../adapters/prisma/PrismaSchedulingRepository';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { ReprocessClosureSideEffects } from '@application/use-cases/ReprocessClosureSideEffects';
import { TaskAutocompleteScheduler } from './TaskAutocompleteScheduler';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
import { buildClosureSideEffects } from './closureSideEffects';

/** Feature flag gating the auto-complete (default OFF). */
const AUTOCOMPLETE_FLAG = 'task-autocomplete';

/**
 * Composition root for the task auto-complete scheduler (#14). Returns null when
 * IClass credentials are missing. Starts dormant: the underlying reprocess checks
 * the `task-autocomplete` flag (default OFF) every tick, so it only runs once an
 * operator flips it on. Reuses ReprocessClosureSideEffects with a dedicated flagKey
 * — same runner as the closure loop, so it also marks the per-task completeness flags.
 *
 * @param intervalMs - Tick interval read from persisted config at startup (default 900000ms / 15 min).
 */
export async function bootstrapTaskAutocomplete(intervalMs: number): Promise<TaskAutocompleteScheduler | null> {
  const { baseUrl, username, password, thirdPartyId } = config.iclass;
  if (!username || !password || !thirdPartyId) {
    console.warn('[task-autocomplete] ICLASS_USERNAME/PASSWORD/THIRD_PARTY_ID missing — not starting');
    return null;
  }

  const iclass = new IClassClient({ baseUrl, username, password, thirdPartyId });
  const closed = new PrismaClosedServiceOrderRepository();
  const ingest = new IngestClosedServiceOrders(
    iclass,
    closed,
    new PrismaIClassResultCodeRepository(),
    new PrismaSchedulingRepository(),
    new PrismaSyncStateRepository(),
    buildClosureSideEffects(),
  );
  const flags = new PrismaFeatureFlagRepository();
  const lock = new PgAdvisoryLock();
  const reprocess = new ReprocessClosureSideEffects(flags, closed, ingest, { flagKey: AUTOCOMPLETE_FLAG });

  // Segunda instancia para el disparo manual — usa el flag independiente 'iclass-closure-reprocess'
  const manualReprocess = new ReprocessClosureSideEffects(flags, closed, ingest, { flagKey: 'iclass-closure-reprocess' });

  return new TaskAutocompleteScheduler(reprocess, { intervalMs }, lock, flags, manualReprocess);
}
