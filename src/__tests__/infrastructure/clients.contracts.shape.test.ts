/**
 * #43 — additive regression for the contract shape returned by toService
 * (PrismaCustomerRepository). Spec CSV-4.3: the existing fields are untouched and
 * the new `name`/`services` are added (services defaults to [] when absent).
 */
import { toService } from '@infrastructure/adapters/prisma/PrismaCustomerRepository';

describe('toService — additive contract shape (#43)', () => {
  const baseRow = {
    id: 'k1',
    type: 'internet',
    plan: 'FIBRA 100MB',
    ip: '10.0.0.1',
    status: 'active',
    startDate: new Date('2024-01-10T00:00:00.000Z'),
    endDate: null,
    address: 'Av. Corrientes 500',
    lat: -34.6,
    lng: -58.4,
  };

  it('preserves the existing fields unchanged (CSV-4.3)', () => {
    const c = toService(baseRow);
    expect(c.id).toBe('k1');
    expect(c.type).toBe('internet');
    expect(c.plan).toBe('FIBRA 100MB');
    expect(c.ip).toBe('10.0.0.1');
    expect(c.status).toBe('active');
    expect(c.startDate).toBe('2024-01-10T00:00:00.000Z');
    expect(c.address).toBe('Av. Corrientes 500');
    expect(c.lat).toBe(-34.6);
    expect(c.lng).toBe(-58.4);
  });

  it('adds name:null for a contract with no manual name (CN-1.2)', () => {
    expect(toService(baseRow).name).toBeNull();
  });

  it('adds services:[] when the contract has no services (CSV-4.2)', () => {
    const c = toService(baseRow);
    expect(c.services).toEqual([]);
  });

  it('maps name when present', () => {
    expect(toService({ ...baseRow, name: 'Antena Trabajo' }).name).toBe('Antena Trabajo');
  });

  it('maps joined services with the embedded shape (no contractId) (CSV-4.1)', () => {
    const row = {
      ...baseRow,
      contractServices: [
        {
          id: 'cs1',
          serviceCatalogId: 'sc1',
          status: 'active',
          notes: 'principal',
          createdAt: new Date('2024-02-01T00:00:00.000Z'),
          serviceCatalog: { name: 'INTERNET', label: 'Internet' },
        },
      ],
    };
    const c = toService(row);
    expect(c.services).toHaveLength(1);
    expect(c.services[0]).toEqual({
      id: 'cs1',
      serviceCatalogId: 'sc1',
      name: 'INTERNET',
      label: 'Internet',
      status: 'active',
      notes: 'principal',
      createdAt: '2024-02-01T00:00:00.000Z',
    });
    expect((c.services[0] as any).contractId).toBeUndefined();
  });
});
