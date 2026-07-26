import {
  FinanceReceiptItem,
  FinanceReceiptItemRepository,
} from '@domain/ports/FinanceReceiptItemRepository';
import { arYearMonth } from '@application/use-cases/finance/financeDates';
import { InMemoryFinancePaymentReceiptRepository } from './InMemoryFinancePaymentReceiptRepository';

export class InMemoryFinanceReceiptItemRepository implements FinanceReceiptItemRepository {
  rows = new Map<string, FinanceReceiptItem>();

  /**
   * fix-wave-3 LOW — reference to the sibling receipts repo. fix-wave-4 W2
   * upgraded this from "only needed by `listByClientAndMonth`" to needed by
   * BOTH read methods: the monthly cut moved from this item's own `fecha`
   * to the PARENT RECEIPT's `fechaRecibo` (measured live: 11,2% of items
   * have no `fecha` at all — see `FinanceReceiptItemRepository.listByMonth`'s
   * docblock), so `listByMonth` now needs to resolve the receipt too. Still
   * technically optional at the type level so tests that never call either
   * read method (only `upsertBatch`, e.g. the ingest use-case tests) don't
   * need to thread it — both methods throw loudly instead of silently
   * returning `[]`/wrong rows when it's missing (fix-wave-1 F13 criterion).
   */
  constructor(private readonly receipts?: InMemoryFinancePaymentReceiptRepository) {}

  async upsertBatch(items: FinanceReceiptItem[]): Promise<void> {
    for (const i of items) this.rows.set(i.grItemId, { ...i });
  }

  /**
   * fix-wave-4 W2 — cuts by the parent receipt's `fechaRecibo`, NOT
   * `item.fecha` (that was the bug: 56/499 items measured with no `fecha` at
   * all disappeared from every month under the old `i.fecha &&
   * arYearMonth(i.fecha) === ym` filter — and this in-memory double replicated
   * that SAME wrong filter, so it never caught the regression).
   */
  async listByMonth(yearMonth: string): Promise<FinanceReceiptItem[]> {
    this.assertReceiptsWired('listByMonth');
    return Array.from(this.rows.values()).filter((i) => {
      const fechaRecibo = this.receipts!.rows.get(i.receiptId)?.fechaRecibo;
      return !!fechaRecibo && arYearMonth(fechaRecibo) === yearMonth;
    });
  }

  async listByClientAndMonth(clientGrId: string, yearMonth: string): Promise<FinanceReceiptItem[]> {
    this.assertReceiptsWired('listByClientAndMonth');
    const monthRows = await this.listByMonth(yearMonth);
    return monthRows.filter((i) => this.receipts!.rows.get(i.receiptId)?.clientGrId === clientGrId);
  }

  // fix-wave-1 F13 criterion, applied to BOTH read methods since fix-wave-4
  // W2 — never silently return `[]`/wrong rows when the sibling repo wasn't
  // threaded in; that would produce a self-confirming mock for whoever
  // builds the Fase 3 cash-attribution read path against this double.
  private assertReceiptsWired(method: string): void {
    if (!this.receipts) {
      throw new Error(
        `InMemoryFinanceReceiptItemRepository.${method}() requires the sibling receipts repo — construct with \`new InMemoryFinanceReceiptItemRepository(receiptsRepo)\`.`,
      );
    }
  }
}
