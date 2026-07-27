/**
 * finance-growth Fase 1 — persistable shape of one `recibo.aplicaciones[]`
 * entry (`FinanceReceiptApplication`, design.md Data Model). `grInvoiceId` is
 * the SAME composite identity `Invoice.grInvoiceId` uses
 * (`"{tipo}-{sucursal}-{numero}"`) but WITHOUT a hard FK to `Invoice`
 * (Decision 0b, deuda declarada #6) — `grType` travels on the application
 * itself, so the metrics engine never needs to join `Invoice`.
 */
export interface FinanceReceiptApplication {
  grApplicationId: string;
  /** FK to `FinancePaymentReceipt.grReceiptId`. */
  receiptId: string;
  grInvoiceId: string;
  grType: string;
  amount: number;
  appliedDate: Date | null;
}

export interface FinanceReceiptApplicationRepository {
  /** Idempotent upsert keyed by `grApplicationId`. */
  upsertBatch(applications: FinanceReceiptApplication[]): Promise<void>;
  /**
   * finance-growth Fase 3 rework (F9) — cuts by the PARENT RECEIPT's
   * `fechaRecibo`, NOT this application's own `appliedDate` (which is
   * nullable — a `null` used to vanish from EVERY month with no error, the
   * SAME blind spot `FinanceReceiptItemRepository` had until fix-wave-4 W2).
   * `unclassifiedAmountArs` (the watchdog specifically built so misclassified
   * money never disappears silently) inherited that exact hole: an
   * application with `appliedDate: null` was invisible to `listByMonth`,
   * so its amount never reached `unclassifiedAmountArs` either. Same
   * criterion, same fix, mirrored from `FinanceReceiptItemRepository`.
   */
  listByMonth(yearMonth: string): Promise<FinanceReceiptApplication[]>;
  /** Applications for one client within a given "YYYY-MM", cut by the parent receipt's `fechaRecibo` (same rationale as `listByMonth`). Fase 3 attribution. */
  listByClientAndMonth(clientGrId: string, yearMonth: string): Promise<FinanceReceiptApplication[]>;
}
