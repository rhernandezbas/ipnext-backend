import { GrReceipt } from '@domain/entities/gestionReal';
import { FinancePaymentReceiptRepository } from '@domain/ports/FinancePaymentReceiptRepository';
import { FinanceReceiptApplicationRepository } from '@domain/ports/FinanceReceiptApplicationRepository';
import { FinanceReceiptItemRepository } from '@domain/ports/FinanceReceiptItemRepository';
import { FinanceReceiptRetencionRepository } from '@domain/ports/FinanceReceiptRetencionRepository';
import { FinanceInvoiceTypeClassificationRepository } from '@domain/ports/FinanceInvoiceTypeClassificationRepository';
import { FinanceReceiptSyncConfig } from '@domain/ports/FinanceReceiptSyncConfigRepository';
import { mapGrReceipt, receiptIdentityHolds, MappedGrReceipt } from './mapGrReceipt';
import { financeAnnulmentGuard } from './financeAnnulmentGuard';
import { FinanceReceiptPersistenceError } from './financeIngestErrors';

/**
 * gr-receipt-annulment (design.md Decision 8) — the ONE fetch→map→guard→persist
 * route shared by all three lanes (delta, backfill, reconcile).
 * `SyncGrReceiptsDelta`/`SyncGrReceiptsBackfillBatch` used to have this body
 * COPIED (map -> 4 upserts -> identity warnings -> auto-alta grTypes -> wrap
 * in `FinanceReceiptPersistenceError`); a third lane would have been the
 * THIRD copy. Extracted here so there is exactly one implementation to trust.
 *
 * `mapAndGuardReceiptPage` maps + runs the systemic guard BEFORE any write
 * (design.md Decision 4: "después del fetch, antes de TODA escritura").
 * Throws `FinanceReceiptAnnulmentGuardError` — never writes anything itself.
 */
export function mapAndGuardReceiptPage(
  receipts: GrReceipt[],
  cfg: Pick<FinanceReceiptSyncConfig, 'annulmentGuardMaxPct' | 'annulmentGuardMinCount'>,
  lane: string,
): MappedGrReceipt[] {
  const mapped = receipts.map(mapGrReceipt);
  financeAnnulmentGuard(mapped, cfg, lane);
  return mapped;
}

export interface PersistReceiptPageRepos {
  receiptRepo: FinancePaymentReceiptRepository;
  applicationRepo: FinanceReceiptApplicationRepository;
  itemRepo: FinanceReceiptItemRepository;
  retencionRepo: FinanceReceiptRetencionRepository;
  invoiceTypes: FinanceInvoiceTypeClassificationRepository;
}

/**
 * The 4 upserts (receipts/applications/items/retenciones) + the
 * SUM(aplicaciones)==SUM(items)+SUM(retenciones) identity warning +
 * auto-alta of unseen `grType`s, wrapped as `FinanceReceiptPersistenceError`
 * so the scheduler can tell "GR is unwell" apart from "a repo write failed
 * while GR was perfectly healthy" (design.md Decision 8 / fix-wave-3 R8).
 * Never touches `SyncState` — cursor bookkeeping stays with each lane's own
 * use case, the only thing that genuinely differs between them.
 */
export async function persistReceiptPage(mapped: MappedGrReceipt[], repos: PersistReceiptPageRepos, lane: string): Promise<void> {
  const receiptRows = mapped.map((m) => m.receipt);
  const applicationRows = mapped.flatMap((m) => m.applications);
  const itemRows = mapped.flatMap((m) => m.items);
  const retencionRows = mapped.flatMap((m) => m.retenciones);

  try {
    await repos.receiptRepo.upsertBatch(receiptRows);
    await repos.applicationRepo.upsertBatch(applicationRows);
    await repos.itemRepo.upsertBatch(itemRows);
    await repos.retencionRepo.upsertBatch(retencionRows);

    // fix-wave-2 R1 — data-integrity guard: SUM(aplicaciones) must equal
    // SUM(items) + SUM(retenciones). A mismatch is logged, never silently
    // swallowed nor a reason to abort ingestion.
    for (const m of mapped) {
      if (!receiptIdentityHolds(m)) {
        console.warn(`[finance-receipts-${lane}] identity mismatch on receipt ${m.receipt.grReceiptId}: aplicaciones != items+retenciones`);
      }
    }

    const seenTypes = new Set(applicationRows.map((a) => a.grType));
    for (const grType of seenTypes) {
      if (grType) await repos.invoiceTypes.upsertIfAbsent(grType);
    }
  } catch (err) {
    throw new FinanceReceiptPersistenceError(err);
  }
}
