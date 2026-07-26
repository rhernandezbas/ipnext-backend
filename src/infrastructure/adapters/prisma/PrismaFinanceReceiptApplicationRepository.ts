import {
  FinanceReceiptApplication,
  FinanceReceiptApplicationRepository,
} from '@domain/ports/FinanceReceiptApplicationRepository';
import { yearMonthToDateRange } from '@application/use-cases/finance/financeDates';
import { prisma } from '../../database/prisma';

interface ApplicationRow {
  grApplicationId: string;
  receiptId: string;
  grInvoiceId: string;
  grType: string;
  amount: unknown; // Prisma.Decimal
  appliedDate: Date | null;
}

function toEntity(row: ApplicationRow): FinanceReceiptApplication {
  return {
    grApplicationId: row.grApplicationId,
    receiptId: row.receiptId,
    grInvoiceId: row.grInvoiceId,
    grType: row.grType,
    amount: Number(row.amount),
    appliedDate: row.appliedDate,
  };
}

/**
 * finance-growth Fase 1 — Prisma adapter for `FinanceReceiptApplication`.
 * `listByClientAndMonth` joins through the `receipt` relation (`clientGrId`
 * lives on `FinancePaymentReceipt`, not here — same shape as the domain port).
 */
export class PrismaFinanceReceiptApplicationRepository implements FinanceReceiptApplicationRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).financeReceiptApplication;
  }

  async upsertBatch(applications: FinanceReceiptApplication[]): Promise<void> {
    if (applications.length === 0) return;
    const ops = applications.map((a) =>
      this.table.upsert({
        where: { grApplicationId: a.grApplicationId },
        create: {
          grApplicationId: a.grApplicationId,
          receiptId: a.receiptId,
          grInvoiceId: a.grInvoiceId,
          grType: a.grType,
          amount: a.amount,
          appliedDate: a.appliedDate,
        },
        update: {
          grInvoiceId: a.grInvoiceId,
          grType: a.grType,
          amount: a.amount,
          appliedDate: a.appliedDate,
        },
      }),
    );
    await prisma.$transaction(ops);
  }

  async listByMonth(yearMonth: string): Promise<FinanceReceiptApplication[]> {
    const { start, endExclusive } = yearMonthToDateRange(yearMonth);
    const rows: ApplicationRow[] = await this.table.findMany({
      where: { appliedDate: { gte: start, lt: endExclusive } },
    });
    return rows.map(toEntity);
  }

  async listByClientAndMonth(clientGrId: string, yearMonth: string): Promise<FinanceReceiptApplication[]> {
    const { start, endExclusive } = yearMonthToDateRange(yearMonth);
    const rows: ApplicationRow[] = await this.table.findMany({
      where: {
        appliedDate: { gte: start, lt: endExclusive },
        receipt: { clientGrId },
      },
    });
    return rows.map(toEntity);
  }
}
