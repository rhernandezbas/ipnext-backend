/**
 * TDD: UpdateContractLocation use case
 * Uses a minimal ContractRepository mock.
 */
import { UpdateContractLocation } from '../../application/use-cases/UpdateContractLocation';
import type { ContractRepository, ContractLocationResult } from '../../domain/ports/ContractRepository';
import { ContractNotFoundError } from '../../domain/errors/contractServices';
import { InvalidLocationError } from '../../domain/errors/geolocation';

const BASE_RESULT: ContractLocationResult = {
  id: 'ct1',
  gpsLat: null,
  gpsLng: null,
  gpsPlusCode: null,
};

function makeRepo(overrides: Partial<ContractRepository> = {}): ContractRepository {
  return {
    list: jest.fn(),
    stats: jest.fn(),
    updateName: jest.fn(),
    listDistinctVendedores: jest.fn(),
    updateLocation: jest.fn().mockResolvedValue(BASE_RESULT),
    findContractTechnologiesByClientIds: jest.fn().mockResolvedValue([]),
    findAllContractTechnologies: jest.fn().mockResolvedValue([]),
    getNetworkAssignments: jest.fn().mockResolvedValue([]),
    updateNetworkAssignment: jest.fn(),
    ...overrides,
  };
}

describe('UpdateContractLocation', () => {
  it('valid update — persists gpsLat/gpsLng/gpsPlusCode and returns result', async () => {
    const updated: ContractLocationResult = { id: 'ct1', gpsLat: -34.6, gpsLng: -58.38, gpsPlusCode: '48Q9+CF' };
    const repo = makeRepo({ updateLocation: jest.fn().mockResolvedValue(updated) });
    const uc = new UpdateContractLocation(repo);

    const result = await uc.execute({ id: 'ct1', gpsLat: -34.6, gpsLng: -58.38, gpsPlusCode: '48Q9+CF' });

    expect(repo.updateLocation).toHaveBeenCalledWith('ct1', { gpsLat: -34.6, gpsLng: -58.38, gpsPlusCode: '48Q9+CF' });
    expect(result.gpsLat).toBe(-34.6);
    expect(result.gpsLng).toBe(-58.38);
    expect(result.gpsPlusCode).toBe('48Q9+CF');
  });

  it('null clears the GPS fields', async () => {
    const cleared: ContractLocationResult = { id: 'ct1', gpsLat: null, gpsLng: null, gpsPlusCode: null };
    const repo = makeRepo({ updateLocation: jest.fn().mockResolvedValue(cleared) });
    const uc = new UpdateContractLocation(repo);

    const result = await uc.execute({ id: 'ct1', gpsLat: null, gpsLng: null, gpsPlusCode: null });

    expect(result.gpsLat).toBeNull();
  });

  it('unknown id → throws ContractNotFoundError (404)', async () => {
    const repo = makeRepo({ updateLocation: jest.fn().mockResolvedValue(null) });
    const uc = new UpdateContractLocation(repo);

    await expect(uc.execute({ id: 'nonexistent', gpsLat: 0, gpsLng: 0 })).rejects.toBeInstanceOf(ContractNotFoundError);
  });

  it('gpsLat out of range → InvalidLocationError before touching the repo', async () => {
    const repo = makeRepo({ updateLocation: jest.fn() });
    const uc = new UpdateContractLocation(repo);

    await expect(uc.execute({ id: 'ct1', gpsLat: 91 })).rejects.toBeInstanceOf(InvalidLocationError);
    expect(repo.updateLocation).not.toHaveBeenCalled();
  });

  it('gpsLng out of range → InvalidLocationError', async () => {
    const repo = makeRepo({ updateLocation: jest.fn() });
    const uc = new UpdateContractLocation(repo);

    await expect(uc.execute({ id: 'ct1', gpsLng: -181 })).rejects.toBeInstanceOf(InvalidLocationError);
    expect(repo.updateLocation).not.toHaveBeenCalled();
  });

  it('bad gpsPlusCode → InvalidLocationError', async () => {
    const repo = makeRepo({ updateLocation: jest.fn() });
    const uc = new UpdateContractLocation(repo);

    await expect(uc.execute({ id: 'ct1', gpsPlusCode: 'INVALID!' })).rejects.toBeInstanceOf(InvalidLocationError);
    expect(repo.updateLocation).not.toHaveBeenCalled();
  });
});
