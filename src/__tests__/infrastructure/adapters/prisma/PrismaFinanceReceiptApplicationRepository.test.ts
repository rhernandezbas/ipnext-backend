import { PrismaFinanceReceiptApplicationRepository } from '@infrastructure/adapters/prisma/PrismaFinanceReceiptApplicationRepository';
import { prisma } from '@infrastructure/database/prisma';

/**
 * gr-receipt-annulment (design.md Decision 6, `finance-dashboard-annulment-filter`
 * spec.md D3/D4) — same criterion as `PrismaFinanceReceiptItemRepository`:
 * without this filter, `unclassifiedAmountArs` and the CAC/payback
 * attribution keep counting voided money forever.
 */
describe('PrismaFinanceReceiptApplicationRepository — anulado filter (D3/D4)', () => {
  afterEach(() => jest.restoreAllMocks());

  function espiar(rows: unknown[] = []) {
    const args: Record<string, unknown>[] = [];
    jest.spyOn(prisma.financeReceiptApplication, 'findMany').mockImplementation((async (a: Record<string, unknown>) => {
      args.push(a);
      return rows;
    }) as never);
    return args;
  }

  it('D3 — listByMonth excludes anulado receipts: where.receipt.anulado === false', async () => {
    const args = espiar();
    await new PrismaFinanceReceiptApplicationRepository().listByMonth('2026-06');

    const where = args[0]?.where as { receipt: { anulado?: unknown } };
    expect(where.receipt.anulado).toBe(false);
  });

  it('D3 — the fechaRecibo range filter is preserved alongside anulado', async () => {
    const args = espiar();
    await new PrismaFinanceReceiptApplicationRepository().listByMonth('2026-06');

    const where = args[0]?.where as { receipt: { fechaRecibo?: unknown; anulado?: unknown } };
    expect(where.receipt.fechaRecibo).toBeDefined();
    expect(where.receipt.anulado).toBe(false);
  });

  it('D4 — listByClientAndMonth excludes anulado receipts AND filters by clientGrId', async () => {
    const args = espiar();
    await new PrismaFinanceReceiptApplicationRepository().listByClientAndMonth('204366', '2026-06');

    const where = args[0]?.where as { receipt: { clientGrId?: unknown; anulado?: unknown } };
    expect(where.receipt.clientGrId).toBe('204366');
    expect(where.receipt.anulado).toBe(false);
  });
});
