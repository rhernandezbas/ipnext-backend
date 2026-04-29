import { GetBillingSummary } from '../../application/use-cases/GetBillingSummary';
import type { BillingRepository } from '../../domain/ports/BillingRepository';
import type { BillingSummary } from '../../domain/entities/billing';

const mockSummary: BillingSummary = {
  totalRevenueThisMonth: 15000,
  totalPending: 3000,
  totalOverdue: 500,
  creditNotesAmount: 200,
  proformaPaidAmount: 1000,
  proformaUnpaidAmount: 400,
};

function makeRepo(overrides?: Partial<BillingRepository>): BillingRepository {
  return {
    getSummary: jest.fn().mockResolvedValue(mockSummary),
    listInvoices: jest.fn(),
    listPayments: jest.fn(),
    listTransactions: jest.fn(),
    ...overrides,
  };
}

describe('GetBillingSummary', () => {
  it('returns summary from repo', async () => {
    const repo = makeRepo();
    const uc = new GetBillingSummary(repo);

    const result = await uc.execute();

    expect(repo.getSummary).toHaveBeenCalled();
    expect(result).toEqual(mockSummary);
  });

  it('includes creditNotesAmount as a number', async () => {
    const repo = makeRepo();
    const uc = new GetBillingSummary(repo);

    const result = await uc.execute();

    expect(typeof result.creditNotesAmount).toBe('number');
  });

  it('includes proformaPaidAmount as a number', async () => {
    const repo = makeRepo();
    const uc = new GetBillingSummary(repo);

    const result = await uc.execute();

    expect(typeof result.proformaPaidAmount).toBe('number');
  });

  it('includes proformaUnpaidAmount as a number', async () => {
    const repo = makeRepo();
    const uc = new GetBillingSummary(repo);

    const result = await uc.execute();

    expect(typeof result.proformaUnpaidAmount).toBe('number');
  });
});
