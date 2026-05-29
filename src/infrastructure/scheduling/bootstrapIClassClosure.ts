import { config } from '../config';
import { IClassClient } from '../adapters/iclass/IClassClient';
import { PrismaClosedServiceOrderRepository } from '../adapters/prisma/PrismaClosedServiceOrderRepository';
import { PrismaIClassResultCodeRepository } from '../adapters/prisma/PrismaIClassResultCodeRepository';
import { PrismaSchedulingRepository } from '../adapters/prisma/PrismaSchedulingRepository';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { IClassClosureScheduler } from './IClassClosureScheduler';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';

/** Default poll cadence for the closure loop (10 min). */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Composition root for the IClass closure-loop scheduler.
 *
 * Returns null when IClass credentials are missing. Otherwise starts dormant:
 * the scheduler re-reads the `iclass-closure-loop` feature flag (default OFF)
 * every tick, so the loop only runs once an operator flips the flag on after
 * mapping result codes → stages.
 */
export function bootstrapIClassClosure(): IClassClosureScheduler | null {
  const { baseUrl, username, password, thirdPartyId } = config.iclass;
  if (!username || !password || !thirdPartyId) {
    console.warn('[iclass-closure] ICLASS_USERNAME/PASSWORD/THIRD_PARTY_ID missing — not starting');
    return null;
  }

  const iclass = new IClassClient({ baseUrl, username, password, thirdPartyId });
  const ingest = new IngestClosedServiceOrders(
    iclass,
    new PrismaClosedServiceOrderRepository(),
    new PrismaIClassResultCodeRepository(),
    new PrismaSchedulingRepository(),
    new PrismaSyncStateRepository(),
  );
  const flags = new PrismaFeatureFlagRepository();
  const lock = new PgAdvisoryLock();

  return new IClassClosureScheduler(ingest, flags, { intervalMs: DEFAULT_INTERVAL_MS }, lock);
}
