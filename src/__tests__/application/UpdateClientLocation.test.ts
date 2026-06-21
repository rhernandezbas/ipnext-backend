/**
 * TDD: UpdateClientLocation use case
 * Uses a minimal CustomerRepository mock (partial interface, no in-memory class needed).
 */
import { UpdateClientLocation } from '../../application/use-cases/UpdateClientLocation';
import type { CustomerRepository } from '../../domain/ports/CustomerRepository';
import type { Customer } from '../../domain/entities/customer';
import { ClientNotFoundError } from '../../domain/errors';
import { InvalidLocationError } from '../../domain/errors/geolocation';

const BASE_CUSTOMER: Customer = {
  id: 'c1',
  name: 'Alice',
  email: 'alice@test.com',
  phone: '111',
  status: 'active',
  address: 'Calle 1',
  city: 'BA',
  country: 'AR',
  login: 'alice',
  createdAt: '2026-01-01T00:00:00.000Z',
  lat: null,
  lng: null,
  plusCode: null,
};

function makeRepo(overrides: Partial<CustomerRepository> = {}): CustomerRepository {
  return {
    list: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    stats: jest.fn(),
    listContracts: jest.fn(),
    listInvoices: jest.fn(),
    listLogs: jest.fn(),
    updateLocation: jest.fn().mockResolvedValue(BASE_CUSTOMER),
    ...overrides,
  };
}

describe('UpdateClientLocation', () => {
  it('valid update — persists lat/lng/plusCode and returns updated customer', async () => {
    const updated: Customer = { ...BASE_CUSTOMER, lat: -34.6037, lng: -58.3816, plusCode: '48Q9+CF' };
    const repo = makeRepo({ updateLocation: jest.fn().mockResolvedValue(updated) });
    const uc = new UpdateClientLocation(repo);

    const result = await uc.execute({ id: 'c1', lat: -34.6037, lng: -58.3816, plusCode: '48Q9+CF' });

    expect(repo.updateLocation).toHaveBeenCalledWith('c1', { lat: -34.6037, lng: -58.3816, plusCode: '48Q9+CF' });
    expect(result.lat).toBe(-34.6037);
    expect(result.lng).toBe(-58.3816);
    expect(result.plusCode).toBe('48Q9+CF');
  });

  it('null clears the GPS fields', async () => {
    const cleared: Customer = { ...BASE_CUSTOMER, lat: null, lng: null, plusCode: null };
    const repo = makeRepo({ updateLocation: jest.fn().mockResolvedValue(cleared) });
    const uc = new UpdateClientLocation(repo);

    const result = await uc.execute({ id: 'c1', lat: null, lng: null, plusCode: null });

    expect(repo.updateLocation).toHaveBeenCalledWith('c1', { lat: null, lng: null, plusCode: null });
    expect(result.lat).toBeNull();
  });

  it('unknown id → throws ClientNotFoundError (404)', async () => {
    const repo = makeRepo({ updateLocation: jest.fn().mockResolvedValue(null) });
    const uc = new UpdateClientLocation(repo);

    await expect(uc.execute({ id: 'nonexistent', lat: 0, lng: 0 })).rejects.toBeInstanceOf(ClientNotFoundError);
  });

  it('lat out of range → InvalidLocationError before touching the repo', async () => {
    const repo = makeRepo({ updateLocation: jest.fn() });
    const uc = new UpdateClientLocation(repo);

    await expect(uc.execute({ id: 'c1', lat: 91 })).rejects.toBeInstanceOf(InvalidLocationError);
    expect(repo.updateLocation).not.toHaveBeenCalled();
  });

  it('lat below -90 → InvalidLocationError', async () => {
    const repo = makeRepo({ updateLocation: jest.fn() });
    const uc = new UpdateClientLocation(repo);

    await expect(uc.execute({ id: 'c1', lat: -91 })).rejects.toBeInstanceOf(InvalidLocationError);
    expect(repo.updateLocation).not.toHaveBeenCalled();
  });

  it('lng out of range → InvalidLocationError before touching the repo', async () => {
    const repo = makeRepo({ updateLocation: jest.fn() });
    const uc = new UpdateClientLocation(repo);

    await expect(uc.execute({ id: 'c1', lng: 181 })).rejects.toBeInstanceOf(InvalidLocationError);
    expect(repo.updateLocation).not.toHaveBeenCalled();
  });

  it('bad plusCode → InvalidLocationError', async () => {
    const repo = makeRepo({ updateLocation: jest.fn() });
    const uc = new UpdateClientLocation(repo);

    await expect(uc.execute({ id: 'c1', plusCode: 'NOT_A_PLUS_CODE' })).rejects.toBeInstanceOf(InvalidLocationError);
    expect(repo.updateLocation).not.toHaveBeenCalled();
  });

  it('undefined values are allowed (no-op for those fields)', async () => {
    const repo = makeRepo();
    const uc = new UpdateClientLocation(repo);

    await uc.execute({ id: 'c1' });
    expect(repo.updateLocation).toHaveBeenCalledWith('c1', { lat: undefined, lng: undefined, plusCode: undefined });
  });
});
