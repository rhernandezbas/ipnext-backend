import { config } from '../config';
import { IClassClient } from '../adapters/iclass/IClassClient';
import { PrismaClosedServiceOrderRepository } from '../adapters/prisma/PrismaClosedServiceOrderRepository';
import { PrismaIClassResultCodeRepository } from '../adapters/prisma/PrismaIClassResultCodeRepository';
import { PrismaIClassStatusCatalogRepository } from '../adapters/prisma/PrismaIClassStatusCatalogRepository';
import { PrismaSchedulingRepository } from '../adapters/prisma/PrismaSchedulingRepository';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { IngestClosedServiceOrders } from '@application/use-cases/IngestClosedServiceOrders';
import { BackfillClosedServiceOrders } from '@application/use-cases/BackfillClosedServiceOrders';
import { BackfillScheduler } from './BackfillScheduler';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
import { buildClosureSideEffects } from './closureSideEffects';

/**
 * Composition root para el BackfillScheduler on-demand (#32).
 * Retorna null cuando faltan credenciales IClass (mirrors bootstrapTaskAutocomplete).
 * No llama a .start() — el scheduler es puramente on-demand.
 */
export async function bootstrapBackfill(): Promise<BackfillScheduler | null> {
  const { baseUrl, username, password, thirdPartyId } = config.iclass;
  if (!username || !password || !thirdPartyId) {
    console.warn('[backfill-scheduler] ICLASS_USERNAME/PASSWORD/THIRD_PARTY_ID missing — not starting');
    return null;
  }

  // FIX 1 — inject statusCatalog so backfill ticks auto-populate the catalog and
  // write iclassStatusCode. Mirrors the wiring in app.ts:785-1574.
  const iclassStatusCatalogRepo = new PrismaIClassStatusCatalogRepository();
  const iclass = new IClassClient({ baseUrl, username, password, thirdPartyId });
  const closed = new PrismaClosedServiceOrderRepository();
  const schedulingRepo = new PrismaSchedulingRepository(iclassStatusCatalogRepo);
  const ingest = new IngestClosedServiceOrders(
    iclass,
    closed,
    new PrismaIClassResultCodeRepository(),
    schedulingRepo,
    new PrismaSyncStateRepository(),
    { ...buildClosureSideEffects(), statusCatalog: iclassStatusCatalogRepo },
  );
  const backfill = new BackfillClosedServiceOrders(iclass, schedulingRepo, ingest);
  const lock = new PgAdvisoryLock();

  return new BackfillScheduler(backfill, lock);
}
