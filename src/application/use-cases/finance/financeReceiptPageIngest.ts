import { GrReceipt } from '@domain/entities/gestionReal';
import { FinancePaymentReceiptRepository } from '@domain/ports/FinancePaymentReceiptRepository';
import { FinanceReceiptApplicationRepository } from '@domain/ports/FinanceReceiptApplicationRepository';
import { FinanceReceiptItemRepository } from '@domain/ports/FinanceReceiptItemRepository';
import { FinanceReceiptRetencionRepository } from '@domain/ports/FinanceReceiptRetencionRepository';
import { FinanceInvoiceTypeClassificationRepository } from '@domain/ports/FinanceInvoiceTypeClassificationRepository';
import { FinanceReceiptSyncConfig } from '@domain/ports/FinanceReceiptSyncConfigRepository';
import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { mapGrReceipt, receiptIdentityHolds, MappedGrReceipt } from './mapGrReceipt';
import { financeAnnulmentGuard, AnnulmentGuardPageContext } from './financeAnnulmentGuard';
import { FinanceReceiptPersistenceError } from './financeIngestErrors';
import { arYearMonth } from './financeDates';
import { enqueueSnapshotRebuild, isWithinNightlyRebuildHorizon } from './financeSnapshotRebuildQueue';

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
  ctx: AnnulmentGuardPageContext,
): MappedGrReceipt[] {
  const mapped = receipts.map(mapGrReceipt);
  financeAnnulmentGuard(mapped, cfg, lane, ctx);
  return mapped;
}

export interface PersistReceiptPageRepos {
  receiptRepo: FinancePaymentReceiptRepository;
  applicationRepo: FinanceReceiptApplicationRepository;
  itemRepo: FinanceReceiptItemRepository;
  retencionRepo: FinanceReceiptRetencionRepository;
  invoiceTypes: FinanceInvoiceTypeClassificationRepository;
  /**
   * gr-receipt-annulment fix-wave RF3 — the SAME `SyncStateRepository` the
   * lane already uses for its own cursor. MANDATORY (never optional-trailing,
   * R9 criterion): this is what queues an out-of-horizon month for the nightly
   * snapshot rebuild, and a lost wiring would make the dashboard disagree with
   * the mirror forever, silently.
   */
  syncState: SyncStateRepository;
}

/**
 * gr-receipt-annulment fix-wave RF1/RF3 — a receipt that was ALREADY mirrored
 * as `anulado: false` and that GR now reports as annulled. Distinct from a
 * brand-new annulled receipt (nothing to repair downstream: no snapshot ever
 * counted it).
 */
export interface ReceiptAnnulmentFlip {
  grReceiptId: string;
  fechaRecibo: Date | null;
  rawFechaAnulacion: string | null;
  /** The month whose `FinanceMonthlySnapshot` counted this receipt's cash — `null` when `fechaRecibo` is missing. */
  yearMonth: string | null;
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
export async function persistReceiptPage(
  mapped: MappedGrReceipt[],
  repos: PersistReceiptPageRepos,
  lane: string,
  now: Date,
): Promise<ReceiptAnnulmentFlip[]> {
  const receiptRows = mapped.map((m) => m.receipt);
  const applicationRows = mapped.flatMap((m) => m.applications);
  const itemRows = mapped.flatMap((m) => m.items);
  const retencionRows = mapped.flatMap((m) => m.retenciones);
  // gr-receipt-annulment fix-wave RF16 — a receipt GR reports as ANNULLED is
  // not a source of truth about the catalog nor about the aplicaciones ==
  // items + retenciones identity: its children are frequently partial (a
  // voided receipt keeps whatever rows it had at the moment of the
  // annulment). Auto-alta'ing a `grType` first seen on an annulled receipt
  // creates a phantom classification an operator then has to bucket by hand,
  // and warning about its identity is pure noise. Both still PERSIST — the
  // rows are the historical record; only the two INFERENCES skip them.
  const live = mapped.filter((m) => !m.receipt.anulado);

  try {
    // ── RF1/RF3: flip detection BEFORE any write, and the rebuild enqueue
    // BEFORE it too. Order matters and is deliberate: if the enqueue fails,
    // NOTHING has been written yet, the whole page is retried, and the flip is
    // still detectable next time. The inverse order would write the flip,
    // fail to enqueue, and then never see that flip again (the row is already
    // `anulado: true`, so it is no longer a flip) — the month would keep the
    // stale cash forever. A spurious queued month (enqueue ok, write fails)
    // costs one redundant, idempotent rebuild.
    const flips = await detectAnnulmentFlips(mapped, repos.receiptRepo);
    const outOfHorizon = [
      ...new Set(
        flips
          .map((f) => f.yearMonth)
          .filter((ym): ym is string => ym !== null && !isWithinNightlyRebuildHorizon(ym, now)),
      ),
    ];
    if (outOfHorizon.length > 0) {
      const queue = await enqueueSnapshotRebuild(repos.syncState, outOfHorizon, now);
      console.warn(
        `[finance-receipts-${lane}] ${outOfHorizon.length} mes(es) FUERA del horizonte del rebuild nocturno tocados por una anulación (${outOfHorizon.join(',')}) — encolados para reconstrucción. Cola pendiente: ${queue.join(',') || '(vacía)'}`,
      );
    }

    await repos.receiptRepo.upsertBatch(receiptRows);
    await repos.applicationRepo.upsertBatch(applicationRows);
    await repos.itemRepo.upsertBatch(itemRows);
    await repos.retencionRepo.upsertBatch(retencionRows);

    // RF1 — one LOUD line per flip, with the raw `fecha_anulacion` GR sent.
    // The latch is one-way by design, so this log is the audit trail for the
    // only case that needs a human: a FALSE annulment stuck on. Paired with
    // the flip-audit SQL in the runbook (tasks.md Fase 10).
    for (const f of flips) {
      console.warn(
        `[finance-receipts-${lane}] ANULACION recibo=${f.grReceiptId} anulado:false->true fecha_anulacion_cruda="${f.rawFechaAnulacion === null ? 'null' : f.rawFechaAnulacion}" fechaRecibo=${f.fechaRecibo ? f.fechaRecibo.toISOString() : 'null'} mes=${f.yearMonth ?? 'n/a'} — LATCH de un solo sentido: no vuelve solo a false, se revierte por SQL a mano.`,
      );
    }

    // fix-wave-2 R1 — data-integrity guard: SUM(aplicaciones) must equal
    // SUM(items) + SUM(retenciones). A mismatch is logged, never silently
    // swallowed nor a reason to abort ingestion. RF16: annulled receipts are
    // excluded — see `live` above.
    for (const m of live) {
      if (!receiptIdentityHolds(m)) {
        console.warn(`[finance-receipts-${lane}] identity mismatch on receipt ${m.receipt.grReceiptId}: aplicaciones != items+retenciones`);
      }
    }

    const seenTypes = new Set(live.flatMap((m) => m.applications).map((a) => a.grType));
    for (const grType of seenTypes) {
      if (grType) await repos.invoiceTypes.upsertIfAbsent(grType);
    }

    return flips;
  } catch (err) {
    throw new FinanceReceiptPersistenceError(err);
  }
}

/**
 * The ids this page reports as annulled that the mirror ALREADY has as
 * `anulado: false`. ONE extra query, and only when the page actually carries
 * an annulled receipt — the overwhelmingly common page (zero annulments)
 * costs nothing.
 */
async function detectAnnulmentFlips(mapped: MappedGrReceipt[], receiptRepo: FinancePaymentReceiptRepository): Promise<ReceiptAnnulmentFlip[]> {
  const incoming = mapped.filter((m) => m.receipt.anulado);
  if (incoming.length === 0) return [];

  const prior = await receiptRepo.annulmentStateOf(incoming.map((m) => m.receipt.grReceiptId));
  return incoming
    .filter((m) => prior.get(m.receipt.grReceiptId) === false)
    .map((m) => ({
      grReceiptId: m.receipt.grReceiptId,
      fechaRecibo: m.receipt.fechaRecibo,
      rawFechaAnulacion: m.rawFechaAnulacion,
      // The snapshot readers cut cash by `receipt.fechaRecibo` (see
      // `PrismaFinanceReceiptItemRepository.listByMonth`), so THAT is the
      // month whose snapshot now overstates the cash.
      yearMonth: m.receipt.fechaRecibo ? arYearMonth(m.receipt.fechaRecibo) : null,
    }));
}
