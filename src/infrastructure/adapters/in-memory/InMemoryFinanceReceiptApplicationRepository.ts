import {
  FinanceReceiptApplication,
  FinanceReceiptApplicationRepository,
} from '@domain/ports/FinanceReceiptApplicationRepository';
import { arYearMonth } from '@application/use-cases/finance/financeDates';
import { InMemoryFinancePaymentReceiptRepository } from './InMemoryFinancePaymentReceiptRepository';

export class InMemoryFinanceReceiptApplicationRepository implements FinanceReceiptApplicationRepository {
  rows = new Map<string, FinanceReceiptApplication>();

  /**
   * Reference to the sibling receipts repo. finance-growth Fase 3 rework
   * (F9) — REQUIRED by both read methods now: the monthly cut moved from
   * this application's own nullable `appliedDate` to the PARENT RECEIPT's
   * `fechaRecibo` (mirrors `InMemoryFinanceReceiptItemRepository`'s
   * fix-wave-4 W2 fix), so `listByMonth` needs to resolve the receipt too.
   * Still optional at the type level so tests that never call either read
   * method (only `upsertBatch`, e.g. the ingest use-case tests) don't need
   * to thread it — both methods throw loudly instead of silently returning
   * `[]`/wrong rows when it's missing (fix-wave-1 F13 criterion).
   */
  constructor(private readonly receipts?: InMemoryFinancePaymentReceiptRepository) {}

  async upsertBatch(applications: FinanceReceiptApplication[]): Promise<void> {
    for (const a of applications) this.rows.set(a.grApplicationId, { ...a });
  }

  /**
   * finance-growth Fase 3 rework (F9) — cuts by the parent receipt's
   * `fechaRecibo`, NOT `application.appliedDate` (that was the bug: an
   * application with `appliedDate: null` vanished from every month under the
   * old `a.appliedDate && arYearMonth(a.appliedDate) === ym` filter, and
   * `unclassifiedAmountArs` — the watchdog that exists so misclassified
   * money never disappears silently — inherited that exact blind spot).
   */
  async listByMonth(yearMonth: string): Promise<FinanceReceiptApplication[]> {
    this.assertReceiptsWired('listByMonth');
    return Array.from(this.rows.values()).filter((a) => {
      const fechaRecibo = this.receipts!.rows.get(a.receiptId)?.fechaRecibo;
      return !!fechaRecibo && arYearMonth(fechaRecibo) === yearMonth;
    });
  }

  async listByClientAndMonth(clientGrId: string, yearMonth: string): Promise<FinanceReceiptApplication[]> {
    this.assertReceiptsWired('listByClientAndMonth');
    const monthRows = await this.listByMonth(yearMonth);
    return monthRows.filter((a) => this.receipts!.rows.get(a.receiptId)?.clientGrId === clientGrId);
  }

  // fix-wave-1 F13 criterion, applied to BOTH read methods since the F9 fix
  // moved the date cut onto the sibling repo — NEVER silently return
  // `[]`/wrong rows when it wasn't threaded in; that would produce a
  // self-confirming mock for whoever builds against this double.
  private assertReceiptsWired(method: string): void {
    if (!this.receipts) {
      throw new Error(
        `InMemoryFinanceReceiptApplicationRepository.${method}() requires the sibling receipts repo — construct with \`new InMemoryFinanceReceiptApplicationRepository(receiptsRepo)\`.`,
      );
    }
  }
}
