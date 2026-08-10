/**
 * finance-growth Fase 1 — persistable shape of a GR payment receipt
 * (`FinancePaymentReceipt`, design.md Data Model). `Invoice` is NEVER upserted
 * from this ingest (Decision 0b) — this is its own table.
 */
export interface FinancePaymentReceipt {
  grReceiptId: string;
  clientGrId: string | null;
  recaudador: string | null;
  fechaRecibo: Date | null;
  fechaConfirmacion: Date | null;
  /**
   * Always `false` in practice — a receipt with a REAL annulment is excluded
   * entirely by the GR-client parser and never reaches this port
   * (design.md Decision 0, gotcha 3). Auditing column, not a runtime filter.
   */
  anulado: boolean;
  observaciones: string | null;
}

export interface FinancePaymentReceiptRepository {
  /** Idempotent upsert keyed by `grReceiptId`. */
  upsertBatch(receipts: FinancePaymentReceipt[]): Promise<void>;
  exists(grReceiptId: string): Promise<boolean>;
  /**
   * gr-receipt-annulment (design.md Decision 9) — which of `grReceiptIds`
   * ALREADY existed in the mirror before this call. ONE query, never N — used
   * by the reconcile lane, once per page, BEFORE persisting, to log how many
   * of the page are newly-caught (the "nuevos=" metric that makes the
   * reconcile window's dimensioning falsifiable).
   */
  existingIds(grReceiptIds: string[]): Promise<Set<string>>;
}
