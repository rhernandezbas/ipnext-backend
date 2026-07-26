import { config } from '../config';
import { GestionRealClient } from '../adapters/gestion-real/GestionRealClient';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { PrismaFinanceReceiptSyncConfigRepository } from '../adapters/prisma/PrismaFinanceReceiptSyncConfigRepository';
import { PrismaFinancePaymentReceiptRepository } from '../adapters/prisma/PrismaFinancePaymentReceiptRepository';
import { PrismaFinanceReceiptApplicationRepository } from '../adapters/prisma/PrismaFinanceReceiptApplicationRepository';
import { PrismaFinanceInvoiceTypeClassificationRepository } from '../adapters/prisma/PrismaFinanceInvoiceTypeClassificationRepository';
import { PrismaFinanceReceiptItemRepository } from '../adapters/prisma/PrismaFinanceReceiptItemRepository';
import { PrismaFinanceReceiptRetencionRepository } from '../adapters/prisma/PrismaFinanceReceiptRetencionRepository';
import { SyncGrReceiptsDelta } from '@application/use-cases/finance/SyncGrReceiptsDelta';
import { SyncGrReceiptsBackfillBatch } from '@application/use-cases/finance/SyncGrReceiptsBackfillBatch';
import { FinanceReceiptIngestScheduler } from './FinanceReceiptIngestScheduler';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';

/**
 * Composition root for the finance-growth Fase 1 receipt ingest (design.md
 * Decision 4b — UN solo scheduler arbitra los carriles delta/backfill con
 * presupuesto compartido; molde `bootstrapGestionRealSync.ts`). Returns a
 * ready-to-start scheduler, or null when GR itself is off/misconfigured (env
 * var `GR_SYNC_ENABLED`/`GR_CUIT`/`GR_SECRET`) — callers just no-op on null.
 *
 * fix-wave-1 F6: `FinanceReceiptSyncConfig.enabled` is NO LONGER checked here
 * at boot — the scheduler itself re-reads the WHOLE config (including
 * `enabled`) fresh on every tick, so flipping the DB flag is an effective
 * runtime kill-switch without a redeploy. Gating on it at boot-time only would
 * mean `enabled=false` set AFTER the process started did nothing (the exact
 * bug this fixes) — the scheduler still exists and ticks, it just no-ops
 * (skips, like a held lock) whenever the live config says disabled.
 *
 * Reuses the SAME GR credentials as `bootstrapGestionRealSync`
 * (`config.gestionReal`) — this is another consumer of the same upstream
 * `GestionRealPort`, not a separate integration.
 */
export async function bootstrapFinanceReceiptsIngest(): Promise<FinanceReceiptIngestScheduler | null> {
  const gr = config.gestionReal;

  if (!gr.enabled) {
    console.log('[finance-receipts] disabled (GR_SYNC_ENABLED != true)');
    return null;
  }
  if (!gr.cuit || !gr.secret) {
    console.warn('[finance-receipts] enabled but GR_CUIT/GR_SECRET missing — not starting');
    return null;
  }

  const syncConfig = new PrismaFinanceReceiptSyncConfigRepository();
  const client = new GestionRealClient({ baseUrl: gr.baseUrl, cuit: gr.cuit, secret: gr.secret });
  const state = new PrismaSyncStateRepository();
  const receiptRepo = new PrismaFinancePaymentReceiptRepository();
  const applicationRepo = new PrismaFinanceReceiptApplicationRepository();
  const invoiceTypes = new PrismaFinanceInvoiceTypeClassificationRepository();
  // fix-wave-2 R1 — items (cash collected) + retenciones (tax certificates),
  // persisted separately from aplicaciones so the metric decision stays
  // reversible without re-ingesting 163 months of history.
  const itemRepo = new PrismaFinanceReceiptItemRepository();
  const retencionRepo = new PrismaFinanceReceiptRetencionRepository();

  // fix-wave-3 R9 — itemRepo/retencionRepo are now MANDATORY constructor args
  // (never optional-trailing) precisely so a future refactor that drops them
  // here fails to COMPILE instead of silently zeroing the cash metric.
  const syncDelta = new SyncGrReceiptsDelta(client, state, receiptRepo, applicationRepo, invoiceTypes, itemRepo, retencionRepo);
  const syncBackfill = new SyncGrReceiptsBackfillBatch(client, state, receiptRepo, applicationRepo, invoiceTypes, syncConfig, itemRepo, retencionRepo);

  // PgAdvisoryLock uses a dedicated pg.Client (not the pool) — same rationale
  // as `bootstrapGestionRealSync` — with its OWN lock key
  // (`finance-receipts-ingest`) so this scheduler never blocks/is blocked by
  // the `gr-sync`/`gr-ingest` schedulers.
  const lock = new PgAdvisoryLock();

  return new FinanceReceiptIngestScheduler(syncDelta, syncBackfill, state, lock, syncConfig);
}
