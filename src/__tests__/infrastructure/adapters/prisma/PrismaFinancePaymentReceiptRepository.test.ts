import { PrismaFinancePaymentReceiptRepository } from '@infrastructure/adapters/prisma/PrismaFinancePaymentReceiptRepository';
import { prisma } from '@infrastructure/database/prisma';

/**
 * gr-receipt-annulment (design.md Decision 9) — `existingIds` runs ONE
 * `findMany({where:{grReceiptId:{in}}})`, never N queries. Spies on the REAL
 * Prisma class (molde `PrismaPortalPaymentsReader.test.ts`) since the
 * invariant ("one query, correct where") lives in the class that actually
 * runs in production.
 */
describe('PrismaFinancePaymentReceiptRepository.existingIds', () => {
  afterEach(() => jest.restoreAllMocks());

  it('queries with grReceiptId IN [...] and returns the matched ids as a Set', async () => {
    const findManySpy = jest.spyOn(prisma.financePaymentReceipt, 'findMany').mockResolvedValue([
      { grReceiptId: 'R1' },
      { grReceiptId: 'R2' },
    ] as never);

    const result = await new PrismaFinancePaymentReceiptRepository().existingIds(['R1', 'R2', 'R3']);

    expect(result).toEqual(new Set(['R1', 'R2']));
    expect(findManySpy).toHaveBeenCalledTimes(1); // ONE query, never N
    expect(findManySpy).toHaveBeenCalledWith({
      where: { grReceiptId: { in: ['R1', 'R2', 'R3'] } },
      select: { grReceiptId: true },
    });
  });

  it('an empty id list short-circuits without querying', async () => {
    const findManySpy = jest.spyOn(prisma.financePaymentReceipt, 'findMany').mockResolvedValue([] as never);
    const result = await new PrismaFinancePaymentReceiptRepository().existingIds([]);
    expect(result).toEqual(new Set());
    expect(findManySpy).not.toHaveBeenCalled();
  });
});
