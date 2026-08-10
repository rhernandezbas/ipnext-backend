import {
  FinancePaymentReceipt,
  FinancePaymentReceiptRepository,
} from '@domain/ports/FinancePaymentReceiptRepository';

export class InMemoryFinancePaymentReceiptRepository implements FinancePaymentReceiptRepository {
  rows = new Map<string, FinancePaymentReceipt>();

  async upsertBatch(receipts: FinancePaymentReceipt[]): Promise<void> {
    for (const r of receipts) this.rows.set(r.grReceiptId, { ...r });
  }

  async exists(grReceiptId: string): Promise<boolean> {
    return this.rows.has(grReceiptId);
  }

  async existingIds(grReceiptIds: string[]): Promise<Set<string>> {
    return new Set(grReceiptIds.filter((id) => this.rows.has(id)));
  }
}
