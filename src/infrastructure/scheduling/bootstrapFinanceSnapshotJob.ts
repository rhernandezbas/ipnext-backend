import { PrismaContractServiceEventRepository } from '../adapters/prisma/PrismaContractServiceEventRepository';
import { PrismaServiceCatalogRepository } from '../adapters/prisma/PrismaServiceCatalogRepository';
import { PrismaPlanRepository } from '../adapters/prisma/PrismaPlanRepository';
import { PrismaPppoeServiceRepository } from '../adapters/prisma/PrismaPppoeServiceRepository';
import { PrismaClientMirrorReadRepository } from '../adapters/prisma/PrismaClientMirrorReadRepository';
import { PrismaFinanceReceiptItemRepository } from '../adapters/prisma/PrismaFinanceReceiptItemRepository';
import { PrismaFinanceReceiptApplicationRepository } from '../adapters/prisma/PrismaFinanceReceiptApplicationRepository';
import { PrismaFinanceInvoiceTypeClassificationRepository } from '../adapters/prisma/PrismaFinanceInvoiceTypeClassificationRepository';
import { PrismaFinancePlanPriceRepository } from '../adapters/prisma/PrismaFinancePlanPriceRepository';
import { PrismaFinanceMonthlySnapshotRepository } from '../adapters/prisma/PrismaFinanceMonthlySnapshotRepository';
import { PrismaFinanceCohortSnapshotRepository } from '../adapters/prisma/PrismaFinanceCohortSnapshotRepository';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { BuildFinanceMonthlySnapshot } from '@application/use-cases/finance/BuildFinanceMonthlySnapshot';
import { BuildFinanceCohortSnapshot } from '@application/use-cases/finance/BuildFinanceCohortSnapshot';
import { FinanceSnapshotScheduler } from './FinanceSnapshotScheduler';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * finance-growth Fase 3 — composition root for the nightly metrics job
 * (design.md Wiring: `BuildFinanceMonthlySnapshot` + `BuildFinanceCohortSnapshot`,
 * ~04:00 AR / any fixed nightly offset works — this job doesn't coordinate
 * with any other schedule, unlike the Fase 1 ingest carriles). Unlike
 * `bootstrapFinanceReceiptsIngest`, this ALWAYS returns a ready scheduler —
 * it never talks to Gestión Real (Decision 5), so there's no
 * enabled/misconfigured upstream to gate on; it only reads what the ingest
 * carriles have ALREADY persisted, whatever that is at the hour it runs.
 */
export async function bootstrapFinanceSnapshotJob(intervalMs = TWENTY_FOUR_HOURS_MS): Promise<FinanceSnapshotScheduler> {
  const eventRepo = new PrismaContractServiceEventRepository();
  const catalogRepo = new PrismaServiceCatalogRepository();
  const planRepo = new PrismaPlanRepository();
  const pppoeRepo = new PrismaPppoeServiceRepository();
  const clientLinks = new PrismaClientMirrorReadRepository();
  const itemRepo = new PrismaFinanceReceiptItemRepository();
  const applicationRepo = new PrismaFinanceReceiptApplicationRepository();
  const classificationRepo = new PrismaFinanceInvoiceTypeClassificationRepository();
  const planPriceRepo = new PrismaFinancePlanPriceRepository();
  const monthlySnapshotRepo = new PrismaFinanceMonthlySnapshotRepository();
  const cohortSnapshotRepo = new PrismaFinanceCohortSnapshotRepository();
  // finance-growth Fase 3 rework (J3) — persists run status so a fully-dead
  // job doesn't look identical to "nothing changed" on /sync/status.
  const syncStateRepo = new PrismaSyncStateRepository();

  const buildMonthly = new BuildFinanceMonthlySnapshot(
    eventRepo,
    catalogRepo,
    planRepo,
    pppoeRepo,
    clientLinks,
    itemRepo,
    applicationRepo,
    classificationRepo,
    planPriceRepo,
    monthlySnapshotRepo,
  );
  const buildCohort = new BuildFinanceCohortSnapshot(eventRepo, catalogRepo, cohortSnapshotRepo);

  // Own PgAdvisoryLock instance with its OWN lock key ('finance-snapshot-job') —
  // never shares a session with FinanceReceiptIngestScheduler's lock
  // ('finance-receipts-ingest'), so a slow snapshot run can never block/be
  // blocked by the receipt ingest ticks.
  const lock = new PgAdvisoryLock();

  return new FinanceSnapshotScheduler(buildMonthly, buildCohort, { intervalMs }, lock, () => new Date(), syncStateRepo);
}
