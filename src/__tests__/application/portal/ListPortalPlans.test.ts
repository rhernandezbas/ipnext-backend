/**
 * customer-portal-api (Fase 4, task 4.3) — ListPortalPlans.
 *
 * portal-self-service spec "Mis planes (GET /api/portal/plans)". Fake
 * CustomerRepository inline minimo (misma convencion que GetPortalMe.test.ts).
 */
import { ListPortalPlans } from '@application/use-cases/portal/ListPortalPlans';
import { Contract } from '@domain/entities/customer';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';

function makeContract(overrides: Partial<Contract>): Contract {
  return {
    id: overrides.id ?? 'contract-1',
    code: 'GR-1',
    type: 'internet',
    plan: '50 Mb Simetrico',
    ip: '10.0.0.1',
    status: 'active',
    startDate: '2025-01-01T00:00:00.000Z',
    endDate: '',
    address: 'Calle Falsa 123',
    lat: null,
    lng: null,
    technology: 'FIBRA',
    name: null,
    vendedor: 'agente-x',
    services: [
      { id: 'svc-1', serviceCatalogId: 'cat-internet', name: 'INTERNET', label: 'Internet', status: 'active', notes: null, createdAt: '2025-01-01T00:00:00.000Z' },
    ],
    ...overrides,
  };
}

class FakeCustomerRepository implements Partial<CustomerRepository> {
  private contractsByClient = new Map<string, Contract[]>();

  seedContracts(clientId: string, contracts: Contract[]): void {
    this.contractsByClient.set(clientId, contracts);
  }

  async listContracts(clientId: string): Promise<Contract[]> {
    return this.contractsByClient.get(clientId) ?? [];
  }
}

describe('ListPortalPlans — customer-portal-api Fase 4.3', () => {
  it('scenario "Cliente con contrato activo": ve su(s) contrato(s) con plan y estado', async () => {
    const repo = new FakeCustomerRepository();
    repo.seedContracts('client-a', [makeContract({ id: 'contract-1', plan: '50 Mb Simetrico', status: 'active' })]);
    const useCase = new ListPortalPlans(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a');

    expect(result).toEqual([
      {
        contractId: 'contract-1',
        plan: '50 Mb Simetrico',
        type: 'internet',
        status: 'active',
        startDate: '2025-01-01T00:00:00.000Z',
        services: [{ name: 'INTERNET', status: 'active' }],
      },
    ]);
  });

  it('no expone campos internos (vendedor, technology, gps, ip)', async () => {
    const repo = new FakeCustomerRepository();
    repo.seedContracts('client-a', [makeContract({ id: 'contract-1' })]);
    const useCase = new ListPortalPlans(repo as unknown as CustomerRepository);

    const result = await useCase.execute('client-a');

    const dto = result[0] as unknown as Record<string, unknown>;
    expect(dto['vendedor']).toBeUndefined();
    expect(dto['technology']).toBeUndefined();
    expect(dto['lat']).toBeUndefined();
    expect(dto['lng']).toBeUndefined();
    expect(dto['ip']).toBeUndefined();
  });

  it('anti-IDOR: dos clientes seedeados, cada llamada ve SOLO sus propios contratos', async () => {
    const repo = new FakeCustomerRepository();
    repo.seedContracts('client-a', [makeContract({ id: 'contract-a', plan: 'Plan A' })]);
    repo.seedContracts('client-b', [makeContract({ id: 'contract-b1', plan: 'Plan B1' }), makeContract({ id: 'contract-b2', plan: 'Plan B2' })]);
    const useCase = new ListPortalPlans(repo as unknown as CustomerRepository);

    const a = await useCase.execute('client-a');
    const b = await useCase.execute('client-b');

    expect(a.map((p) => p.plan)).toEqual(['Plan A']);
    expect(b.map((p) => p.plan).sort()).toEqual(['Plan B1', 'Plan B2']);
  });
});
