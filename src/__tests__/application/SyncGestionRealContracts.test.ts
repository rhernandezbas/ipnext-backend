import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { SyncGestionRealContracts } from '@application/use-cases/SyncGestionRealContracts';
import { GrContract } from '@domain/entities/gestionReal';

function makeContract(id: string, cli: string, overrides: Partial<GrContract> = {}): GrContract {
  return {
    grContratoId: id,
    grClienteId: cli,
    plan: '50MB FO',
    status: 'Vigente',
    startDate: '01-05-2023',
    address: 'Calle 29',
    lat: null,
    lng: null,
    pppoeUsername: `user${id}`,
    modificado: '27-04-2026 11:01:27',
    fechaCreacion: null,
    vendedor: null,
    motivoBaja: null,
    raw: { id },
    ...overrides,
  };
}

describe('SyncGestionRealContracts', () => {
  let gr: InMemoryGestionRealPort;
  let mirror: InMemoryClientMirrorRepository;
  let sync: SyncGestionRealContracts;

  beforeEach(() => {
    gr = new InMemoryGestionRealPort();
    mirror = new InMemoryClientMirrorRepository();
    sync = new SyncGestionRealContracts(gr, mirror);
  });

  it('upserts the contracts of the given clients', async () => {
    gr.contractsByClient = {
      '100': [makeContract('c1', '100'), makeContract('c2', '100')],
      '200': [makeContract('c3', '200')],
    };
    const res = await sync.execute(['100', '200']);

    expect(res.fetched).toBe(3);
    expect(res.created).toBe(3);
    expect(mirror.contracts.size).toBe(3);
  });

  it('is idempotent — re-running updates instead of creating', async () => {
    gr.contractsByClient = { '100': [makeContract('c1', '100')] };
    await sync.execute(['100']);
    const res = await sync.execute(['100']);

    expect(res.created).toBe(0);
    expect(res.updated).toBe(1);
  });

  it('handles clients with no contracts gracefully', async () => {
    const res = await sync.execute(['999']);
    expect(res.fetched).toBe(0);
    expect(res.created).toBe(0);
  });

  it('stores address, lat, lng when the contract has them', async () => {
    gr.contractsByClient = {
      '300': [makeContract('c10', '300', { address: 'CALLE 29 N?1284', lat: -35.040958, lng: -59.910656 })],
    };
    await sync.execute(['300']);
    const stored = mirror.contracts.get('c10');
    expect(stored?.address).toBe('CALLE 29 N?1284');
    expect(stored?.lat).toBeCloseTo(-35.040958);
    expect(stored?.lng).toBeCloseTo(-59.910656);
  });

  it('stores null address/lat/lng when the contract has none', async () => {
    gr.contractsByClient = {
      '301': [makeContract('c11', '301', { address: null, lat: null, lng: null })],
    };
    await sync.execute(['301']);
    const stored = mirror.contracts.get('c11');
    expect(stored?.address).toBeNull();
    expect(stored?.lat).toBeNull();
    expect(stored?.lng).toBeNull();
  });
});
