/**
 * #65 — ChangeTvPassword: PATCH /accounts/{cic} { password } + persist the new
 * password on the local TV ContractService slot (visible to the operator).
 */
import { ChangeTvPassword } from '@application/use-cases/gigared/ChangeTvPassword';
import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { GigaredInvalidPasswordError } from '@domain/errors/gigared';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  return {
    cic: '0000001234', gigaredId: '2432', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '19/01/2026', services: [{ id: '129', name: 'Gigared Play Full' }],
    internalId: 'cust-1', ott: null, ...over,
  };
}
function fakePort(over: Partial<GigaredPort> = {}): GigaredPort {
  return {
    getSummary: jest.fn(async () => ({ accounts: { registered: 0, unregistered: 0, total: 0 }, services: [] })),
    listAccounts: jest.fn(async () => []),
    getAccountByInternalId: jest.fn(async () => fakeAccount()),
    getAccountByCic: jest.fn(async () => fakeAccount()),
    register: jest.fn(async () => {}), activate: jest.fn(async () => {}), setInternalId: jest.fn(async () => {}),
    addService: jest.fn(async () => {}), removeService: jest.fn(async () => {}), setOtt: jest.fn(async () => {}),
    changePassword: jest.fn(async () => {}),
    renewCic: jest.fn(async () => ({ oldCic: '0000001234', newCic: '0000001235' })),
    ...over,
  };
}

const customerLookup = (exists: boolean) => ({ findById: async (id: string) => (exists ? { id } : null) });
const contractLookup = (exists: boolean, ownerId = 'cust-1') => ({
  findById: async (id: string) => (exists ? { id, clientId: ownerId } : null),
});

describe('ChangeTvPassword (#65)', () => {
  let cs: InMemoryContractServiceRepository;
  let catalog: InMemoryServiceCatalogRepository;

  beforeEach(async () => {
    cs = new InMemoryContractServiceRepository();
    catalog = new InMemoryServiceCatalogRepository();
    const cat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cs as any).catalog[cat.id] = { name: cat.name, label: cat.label };
  });

  async function seedTvRow() {
    const tvId = (await catalog.getByName('TV'))!.id;
    return cs.add({ contractId: 'C1', serviceCatalogId: tvId, notes: 'CIC 0000001234 · Gigared Play Full' });
  }

  it('PATCHes the password and persists it on the TV row', async () => {
    await seedTvRow();
    const port = fakePort();
    const uc = new ChangeTvPassword(port, customerLookup(true), contractLookup(true), cs, catalog);
    const result = await uc.execute('cust-1', { cic: '0000001234', contractId: 'C1', password: 'ip243200' });

    expect(port.changePassword).toHaveBeenCalledWith('0000001234', 'ip243200');
    const tvId = (await catalog.getByName('TV'))!.id;
    const row = await cs.getByPair('C1', tvId);
    expect(row!.tvPassword).toBe('ip243200');
    expect(result.password).toBe('ip243200');
  });

  it('rejects a non-CUA password BEFORE calling Gigared', async () => {
    const port = fakePort();
    const uc = new ChangeTvPassword(port, customerLookup(true), contractLookup(true), cs, catalog);
    await expect(uc.execute('cust-1', { cic: '0000001234', contractId: 'C1', password: 'ABC-123' }))
      .rejects.toBeInstanceOf(GigaredInvalidPasswordError);
    expect(port.changePassword).not.toHaveBeenCalled();
  });

  it('rejects an unknown customer', async () => {
    const port = fakePort();
    const uc = new ChangeTvPassword(port, customerLookup(false), contractLookup(true), cs, catalog);
    await expect(uc.execute('ghost', { cic: '0000001234', contractId: 'C1', password: 'ip243200' }))
      .rejects.toBeInstanceOf(ClientNotFoundError);
  });

  it('rejects a foreign contract (404) before calling Gigared', async () => {
    const port = fakePort();
    const uc = new ChangeTvPassword(port, customerLookup(true), contractLookup(true, 'cust-B'), cs, catalog);
    await expect(uc.execute('cust-1', { cic: '0000001234', contractId: 'C-of-B', password: 'ip243200' }))
      .rejects.toBeInstanceOf(ContractNotFoundError);
    expect(port.changePassword).not.toHaveBeenCalled();
  });
});
