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
  /**
   * Idempotent upsert keyed by `grReceiptId`.
   *
   * gr-receipt-annulment fix-wave RF1 — `anulado` follows a ONE-WAY LATCH on
   * the UPDATE path (an INSERT always writes the honest incoming value):
   *
   *  - incoming `true`  → written (this is the flip the reconcile lane exists
   *    for; before this fix the update branch omitted the field entirely and
   *    an already-mirrored receipt could NEVER become annulled).
   *  - incoming `false` → NOT written. An already-annulled row stays annulled.
   *
   * The asymmetry is deliberate and load-bearing: GR omitting/blanking
   * `fecha_anulacion` on a page (a format drift, a partial response) would
   * otherwise de-annul the whole mirror in one sweep — mass de-annulment is
   * indistinguishable from healthy data at read time, so no guard downstream
   * could catch it. The accepted cost is the inverse: a FALSE annulment (a
   * parseable-date drift slipping under `annulmentGuardMinCount` on a tail
   * page) stays stuck. That case is covered by the loud per-flip log
   * (`persistReceiptPage`) plus the flip-audit query in the runbook — a human
   * un-annuls it by SQL, deliberately, which is exactly the right blast radius
   * for reversing a money-visible decision.
   */
  upsertBatch(receipts: FinancePaymentReceipt[]): Promise<void>;
  exists(grReceiptId: string): Promise<boolean>;
  /**
   * gr-receipt-annulment fix-wave RF1 — current `anulado` for each id that
   * ALREADY has a row (an id absent from the returned Map has no row yet).
   * ONE query, never N. Read BEFORE `upsertBatch` so the ingest can tell a
   * genuine FLIP (existing row, was `false`, now `true`) apart from a brand
   * new annulled receipt — only the former is logged as a flip and only the
   * former can require rebuilding an already-closed snapshot month.
   */
  annulmentStateOf(grReceiptIds: string[]): Promise<Map<string, boolean>>;
  /**
   * gr-receipt-annulment (design.md Decision 9) — which of `grReceiptIds`
   * ALREADY existed in the mirror before this call. ONE query, never N — used
   * by the reconcile lane, once per page, BEFORE persisting, to log how many
   * of the page are newly-caught (the "nuevos=" metric that makes the
   * reconcile window's dimensioning falsifiable).
   */
  existingIds(grReceiptIds: string[]): Promise<Set<string>>;
}
