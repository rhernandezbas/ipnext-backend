import { config } from '../config';
import { IClassClient } from '../adapters/iclass/IClassClient';
import { PrismaClosedServiceOrderRepository } from '../adapters/prisma/PrismaClosedServiceOrderRepository';
import { PrismaIClassResultCodeRepository } from '../adapters/prisma/PrismaIClassResultCodeRepository';
import { PrismaIClassStatusCatalogRepository } from '../adapters/prisma/PrismaIClassStatusCatalogRepository';
import { PrismaSchedulingRepository } from '../adapters/prisma/PrismaSchedulingRepository';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { IClassClosureScheduler } from './IClassClosureScheduler';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
import { buildClosureSideEffects } from './closureSideEffects';

/**
 * Composition root for the IClass closure-loop scheduler.
 *
 * Returns null when IClass credentials are missing. Otherwise starts dormant:
 * the scheduler re-reads the `iclass-closure-loop` feature flag (default OFF)
 * every tick, so the loop only runs once an operator flips the flag on after
 * mapping result codes → stages.
 *
 * @param intervalMs - Tick interval read from persisted config at startup (default 600000ms / 10 min).
 */
export async function bootstrapIClassClosure(intervalMs: number): Promise<IClassClosureScheduler | null> {
  const { baseUrl, username, password, thirdPartyId } = config.iclass;
  if (!username || !password || !thirdPartyId) {
    console.warn('[iclass-closure] ICLASS_USERNAME/PASSWORD/THIRD_PARTY_ID missing — not starting');
    return null;
  }

  // FIX 1 — inject statusCatalog so the cron tick auto-populates the catalog and
  // writes iclassStatusCode on each OS. Mirrors the wiring in app.ts:785-1574.
  const iclassStatusCatalogRepo = new PrismaIClassStatusCatalogRepository();
  const iclass = new IClassClient({ baseUrl, username, password, thirdPartyId });
  const ingest = new IngestClosedServiceOrders(
    iclass,
    new PrismaClosedServiceOrderRepository(),
    new PrismaIClassResultCodeRepository(),
    new PrismaSchedulingRepository(iclassStatusCatalogRepo),
    new PrismaSyncStateRepository(),
    { ...buildClosureSideEffects(), statusCatalog: iclassStatusCatalogRepo },
  );
  const flags = new PrismaFeatureFlagRepository();
  const lock = new PgAdvisoryLock();

  return new IClassClosureScheduler(ingest, flags, { intervalMs }, lock);
}
