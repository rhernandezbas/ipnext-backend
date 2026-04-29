import { ListClients } from '../../application/use-cases/ListClients';
import type { CustomerRepository } from '../../domain/ports/CustomerRepository';
import type { Customer } from '../../domain/entities/customer';

const mockCustomer: Customer = {
  id: '1',
  name: 'Alice García',
  email: 'alice@example.com',
  phone: '11-1111',
  status: 'active',
  address: 'Av. Corrientes 1234',
  city: 'CABA',
  country: 'AR',
  login: 'alice',
  createdAt: '2024-01-01',
};

function makeRepo(overrides?: Partial<CustomerRepository>): CustomerRepository {
  return {
    list: jest.fn().mockResolvedValue({ data: [mockCustomer], total: 1, page: 1, totalPages: 1 }),
    findById: jest.fn(),
    listServices: jest.fn(),
    listInvoices: jest.fn(),
    listLogs: jest.fn(),
    ...overrides,
  };
}

describe('ListClients', () => {
  it('delegates to repo.list with defaults', async () => {
    const repo = makeRepo();
    const uc = new ListClients(repo);

    const result = await uc.execute({});

    expect(repo.list).toHaveBeenCalledWith({ page: 1, limit: 25, search: undefined, status: undefined });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].name).toBe('Alice García');
  });

  it('passes query params to repo.list', async () => {
    const repo = makeRepo();
    const uc = new ListClients(repo);

    await uc.execute({ page: 2, limit: 10, search: 'Alice', status: 'active' });

    expect(repo.list).toHaveBeenCalledWith({ page: 2, limit: 10, search: 'Alice', status: 'active' });
  });

  it('applies page default of 1', async () => {
    const repo = makeRepo();
    const uc = new ListClients(repo);

    await uc.execute({ limit: 10 });

    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
  });

  it('applies limit default of 25', async () => {
    const repo = makeRepo();
    const uc = new ListClients(repo);

    await uc.execute({ page: 1 });

    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });
});
