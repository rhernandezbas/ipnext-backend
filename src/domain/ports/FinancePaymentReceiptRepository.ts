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
   * gr-receipt-annulment (design.md Decision 3) — TRUE when GR reports a real
   * `fecha_anulacion` for this receipt (derived by `mapGrReceipt` via
   * `isRealAnnulment`). NO LONGER "always false in practice": the parser used
   * to exclude annulled receipts before they ever reached this port — now
   * they're persisted WITH the flag, and the four dashboard readers
   * (`finance-dashboard-annulment-filter`) + `PrismaPortalPaymentsReader`
   * filter `anulado: false` at read time.
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
