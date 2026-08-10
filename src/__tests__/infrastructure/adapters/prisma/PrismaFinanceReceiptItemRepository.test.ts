import { PrismaFinanceReceiptItemRepository } from '@infrastructure/adapters/prisma/PrismaFinanceReceiptItemRepository';
import { prisma } from '@infrastructure/database/prisma';

/**
 * gr-receipt-annulment (design.md Decision 6, `finance-dashboard-annulment-filter`
 * spec.md D1) — closes deuda #7 of `finance-growth-dashboard`: without this
 * filter, marking `anulado` correctly on the ingest side changes nothing on
 * the dashboard — the voided money keeps counting forever. Spies on the REAL
 * Prisma class (molde `PrismaPortalPaymentsReader.test.ts`) because the
 * invariant lives in the `where` object of the class that actually runs in
 * production.
 */
describe('PrismaFinanceReceiptItemRepository — anulado filter (D1/D2)', () => {
  afterEach(() => jest.restoreAllMocks());

  function espiar(rows: unknown[] = []) {
    const args: Record<string, unknown>[] = [];
    jest.spyOn(prisma.financeReceiptItem, 'findMany').mockImplementation((async (a: Record<string, unknown>) => {
      args.push(a);
      return rows;
    }) as never);
    return args;
  }

  it('D1 — listByMonth excludes anulado receipts: where.receipt.anulado === false', async () => {
    const args = espiar();
    await new PrismaFinanceReceiptItemRepository().listByMonth('2026-06');

    expect(args).toHaveLength(1);
    const where = args[0]?.where as { receipt: { anulado?: unknown } };
    expect(where.receipt.anulado).toBe(false);
  });

  it('D1 — the fechaRecibo range filter is preserved alongside anulado', async () => {
    const args = espiar();
    await new PrismaFinanceReceiptItemRepository().listByMonth('2026-06');

    const where = args[0]?.where as { receipt: { fechaRecibo?: unknown; anulado?: unknown } };
    expect(where.receipt.fechaRecibo).toBeDefined();
    expect(where.receipt.anulado).toBe(false);
  });

  it('D2 — listByClientAndMonth excludes anulado receipts AND filters by clientGrId', async () => {
    const args = espiar();
    await new PrismaFinanceReceiptItemRepository().listByClientAndMonth('204366', '2026-06');

    const where = args[0]?.where as { receipt: { clientGrId?: unknown; anulado?: unknown } };
    expect(where.receipt.clientGrId).toBe('204366');
    expect(where.receipt.anulado).toBe(false);
  });
});
