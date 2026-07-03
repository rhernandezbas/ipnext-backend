import { GetClientDetail } from '../../application/use-cases/GetClientDetail';
import { RefreshClientBalanceIfStale } from '../../application/use-cases/RefreshClientBalanceIfStale';
import type { CustomerRepository } from '../../domain/ports/CustomerRepository';
import type { Customer } from '../../domain/entities/customer';

const mockCustomer: Customer = {
  id: '42',
  name: 'Bob Martínez',
  email: 'bob@example.com',
  phone: '22-2222',
  status: 'inactive',
  address: 'Calle Falsa 123',
  city: 'Rosario',
  country: 'AR',
  login: 'bob',
  createdAt: '2024-02-01',
};

function makeRepo(overrides?: Partial<CustomerRepository>): CustomerRepository {
  return {
    list: jest.fn(),
    findById: jest.fn().mockResolvedValue(mockCustomer),
    create: jest.fn(),
    delete: jest.fn(),
    stats: jest.fn(),
    listContracts: jest.fn(),
    listInvoices: jest.fn(),
    listLogs: jest.fn(),
    updateLocation: jest.fn(),
    ...overrides,
  };
}

describe('GetClientDetail', () => {
  it('calls repo.findById with the given id', async () => {
    const repo = makeRepo();
    const uc = new GetClientDetail(repo);

    const result = await uc.execute('42');

    expect(repo.findById).toHaveBeenCalledWith('42');
    expect(result).toEqual(mockCustomer);
  });

  it('propagates errors from repo.findById', async () => {
    const repo = makeRepo({
      findById: jest.fn().mockRejectedValue(new Error('Not found')),
    });
    const uc = new GetClientDetail(repo);

    await expect(uc.execute('999')).rejects.toThrow('Not found');
  });

  describe('on-demand balance refresh gate', () => {
    function makeRefresh() {
      return { execute: jest.fn().mockResolvedValue(false) } as unknown as RefreshClientBalanceIfStale;
    }

    it('triggers the refresh for ANY client with a grClienteId (not just debtors)', async () => {
      // An ACTIVE client (status 'active') with a GR link must still sync.
      const activeWithGr: Customer = { ...mockCustomer, status: 'active', grClienteId: '100011', lastBalanceAt: null };
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(activeWithGr) });
      const refresh = makeRefresh();
      const uc = new GetClientDetail(repo, refresh);

      await uc.execute('42');

      expect(refresh.execute).toHaveBeenCalledWith({ grClienteId: '100011', lastBalanceAt: null });
    });

    it('does NOT trigger the refresh for a client without a grClienteId', async () => {
      const noGr: Customer = { ...mockCustomer, status: 'active', grClienteId: null };
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(noGr) });
      const refresh = makeRefresh();
      const uc = new GetClientDetail(repo, refresh);

      await uc.execute('42');

      expect(refresh.execute).not.toHaveBeenCalled();
    });

    it('reloads the customer when the refresh fetched fresh data', async () => {
      const stale: Customer = { ...mockCustomer, status: 'active', grClienteId: '100011', balanceDue: null };
      const fresh: Customer = { ...stale, balanceDue: 5000 };
      const findById = jest.fn()
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(fresh);
      const repo = makeRepo({ findById });
      const refresh = { execute: jest.fn().mockResolvedValue(true) } as unknown as RefreshClientBalanceIfStale;
      const uc = new GetClientDetail(repo, refresh);

      const result = await uc.execute('42');

      expect(findById).toHaveBeenCalledTimes(2);
      expect(result.balanceDue).toBe(5000);
    });
  });
});
