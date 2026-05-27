import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { SyncGestionRealContracts } from '@application/use-cases/SyncGestionRealContracts';
import { GrContract } from '@domain/entities/gestionReal';

function makeContract(id: string, cli: string): GrContract {
  return {
    grContratoId: id,
    grClienteId: cli,
    plan: '50MB FO',
    status: 'Vigente',
    startDate: '01-05-2023',
    address: 'Calle 29',
    pppoeUsername: `user${id}`,
    modificado: '27-04-2026 11:01:27',
    raw: { id },
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
});
