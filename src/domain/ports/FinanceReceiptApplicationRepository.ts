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
  /** All applications whose `appliedDate` falls in the given "YYYY-MM" (Argentina calendar). */
  listByMonth(yearMonth: string): Promise<FinanceReceiptApplication[]>;
  /** Applications for one client (via its receipts) within a given "YYYY-MM". Fase 3 attribution. */
  listByClientAndMonth(clientGrId: string, yearMonth: string): Promise<FinanceReceiptApplication[]>;
}
