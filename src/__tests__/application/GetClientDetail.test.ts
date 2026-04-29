import { GetClientDetail } from '../../application/use-cases/GetClientDetail';
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
    listServices: jest.fn(),
    listInvoices: jest.fn(),
    listLogs: jest.fn(),
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
});
