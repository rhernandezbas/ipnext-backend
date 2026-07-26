/**
 * finance-growth Fase 1 (fix-wave-2 R1) — persistable shape of one
 * `recibo.items[]` entry: a payment-method line that represents CASH actually
 * received. This is the base for the "cash collected" metric mandated by
 * spec.md ("The growth metric basis is cash collected") — `aplicaciones`
 * (`FinanceReceiptApplication`) is debt CANCELLED, not cash; `items` is the
 * only node GR reports that IS cash. Persisted in its own table (never
 * inferred/derived) so the cobranza/retenciones split is reversible without
 * re-ingesting the 163 months of GR history — see design.md Decision 0/0b.
 */
export interface FinanceReceiptItem {
  grItemId: string;
  /** FK to `FinancePaymentReceipt.grReceiptId`. */
  receiptId: string;
  banco: string | null;
  cajaCuentaId: string | null;
  destino: string | null;
  fecha: Date | null;
  amount: number;
  moneda: string | null;
  numeroTransferencia: string | null;
  tipo: string | null;
}

export interface FinanceReceiptItemRepository {
  /** Idempotent upsert keyed by `grItemId`. */
  upsertBatch(items: FinanceReceiptItem[]): Promise<void>;
  /**
   * fix-wave-3 LOW (read-path asymmetry) — before this, `FinanceReceiptItem`
   * was write-only (`upsertBatch` and nothing else) while
   * `FinanceReceiptApplicationRepository` exposed `listByMonth`/
   * `listByClientAndMonth`. `design.md` says the growth metric "DEBE leer
   * `FinanceReceiptItem`" (cash collected, spec.md), but nothing enforced
   * it — summing `aplicaciones` (debt cancelled, NOT cash — the exact bug R1
   * fixed) stayed the path of LEAST resistance for whoever builds Fase 3,
   * because it was the only one with a ready-made read method.
   *
   * fix-wave-4 W2 — cuts by the PARENT RECEIPT's `fechaRecibo`, NOT this
   * item's own `fecha`. Measured live (500 recibos, junio 2026): `fecha` is
   * ABSENT (the key doesn't exist on the wire) on 11,2% of items (56/499,
   * 10,4% of the cash), and even when present can land in a DIFFERENT month
   * than the receipt (measured: 29-05 vs recibo 01-06). Cutting by `item.fecha`
   * silently drops those 56 rows from EVERY month (invisible from the query —
   * they're simply never returned) and, separately, would file the other row
   * under the wrong month. The ground-truth cash number the user authorized
   * was measured by `fecha_recibo`, so this is also the only cut that
   * reproduces the approved figure. Same criterion applies to
   * `FinanceReceiptRetencion` if/when it grows a read path (currently
   * write-only — accepted debt, not this fix's scope).
   */
  listByMonth(yearMonth: string): Promise<FinanceReceiptItem[]>;
  /**
   * Items for one client within a given "YYYY-MM", cut by the parent
   * receipt's `fechaRecibo` (fix-wave-4 W2 — same rationale as `listByMonth`).
   * Fase 3 attribution — same molde as the application repo's equivalent.
   */
  listByClientAndMonth(clientGrId: string, yearMonth: string): Promise<FinanceReceiptItem[]>;
}
