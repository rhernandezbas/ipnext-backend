/**
 * finance-growth Fase 1 (fix-wave-2 R1) — persistable shape of one
 * `recibo.retenciones[]` entry: a tax-withholding certificate (retiva/retgan/
 * retib/retpat — open vocabulary, no enum) applied against the receipt. NEVER
 * cash — a receipt can be 100% retenciones with zero `items` (measured: 7 of
 * 18 June-2026 receipts carrying `retenciones` have NO `items` at all).
 * Persisted as its own line, exposed as a series SEPARATE from the cash
 * metric (spec.md "cash collected"), never netted silently into it.
 */
export interface FinanceReceiptRetencion {
  grRetencionId: string;
  /** FK to `FinancePaymentReceipt.grReceiptId`. */
  receiptId: string;
  tipo: string | null;
  amount: number;
  fecha: Date | null;
}

export interface FinanceReceiptRetencionRepository {
  /** Idempotent upsert keyed by `grRetencionId`. */
  upsertBatch(retenciones: FinanceReceiptRetencion[]): Promise<void>;
}
