import {
  FinanceReceiptApplication,
  FinanceReceiptApplicationRepository,
} from '@domain/ports/FinanceReceiptApplicationRepository';
import { arYearMonth } from '@application/use-cases/finance/financeDates';
import { InMemoryFinancePaymentReceiptRepository } from './InMemoryFinancePaymentReceiptRepository';

export class InMemoryFinanceReceiptApplicationRepository implements FinanceReceiptApplicationRepository {
  rows = new Map<string, FinanceReceiptApplication>();

  /**
   * Optional reference to the sibling receipts repo, used ONLY to resolve
   * `clientGrId` for `listByClientAndMonth` (the domain type here has no
   * `clientGrId` of its own — it travels on the parent receipt, same as the
   * real schema's FK relation). Omit it in tests that never exercise that method.
   */
  constructor(private readonly receipts?: InMemoryFinancePaymentReceiptRepository) {}

  async upsertBatch(applications: FinanceReceiptApplication[]): Promise<void> {
    for (const a of applications) this.rows.set(a.grApplicationId, { ...a });
  }

  async listByMonth(yearMonth: string): Promise<FinanceReceiptApplication[]> {
    return Array.from(this.rows.values()).filter((a) => a.appliedDate && arYearMonth(a.appliedDate) === yearMonth);
  }

  async listByClientAndMonth(clientGrId: string, yearMonth: string): Promise<FinanceReceiptApplication[]> {
    // fix-wave-1 F13: NEVER silently return `[]` when the sibling repo wasn't
    // threaded in — that produced a self-confirming mock (a Fase 3 test that
    // forgets to wire it asserts "atribución = $0" and PASSES, hiding a real
    // attribution bug). The real Prisma adapter resolves this via a JOIN that
    // never "forgets"; the in-memory double must fail loudly on the same gap.
    if (!this.receipts) {
      throw new Error(
        'InMemoryFinanceReceiptApplicationRepository.listByClientAndMonth() requires the sibling receipts repo — construct with `new InMemoryFinanceReceiptApplicationRepository(receiptsRepo)`.',
      );
    }
    const monthRows = await this.listByMonth(yearMonth);
    return monthRows.filter((a) => this.receipts!.rows.get(a.receiptId)?.clientGrId === clientGrId);
  }
}
