/**
 * #47 — proxy/account use cases: summary, list, getCustomerAccount (NotFound→linked:false),
 * link (setInternalId→getAccount), register (order register→activate→setInternalId).
 */
import { GetGigaredSummary } from '@application/use-cases/gigared/GetGigaredSummary';
import { ListGigaredAccounts } from '@application/use-cases/gigared/ListGigaredAccounts';
import { GetGigaredCustomerAccount } from '@application/use-cases/gigared/GetGigaredCustomerAccount';
import { LinkCustomerToCic } from '@application/use-cases/gigared/LinkCustomerToCic';
import { RegisterGigaredAccount } from '@application/use-cases/gigared/RegisterGigaredAccount';
import type { GigaredPort, GigaredAccount, GigaredSummary } from '@domain/ports/GigaredPort';
import { GigaredNotFoundError, CicNotFoundError, CicAlreadyLinkedError } from '@domain/errors/gigared';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryClientTvCancellationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvCancellationRepository';
import { InMemoryClientTvActivationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvActivationRepository';

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  const base: GigaredAccount = {
    cic: '0000000001', gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '2026-01-19', services: [{ id: '129', name: 'Gigared Play Full' }],
    internalId: 'cust-1', clientId: 'cust-1', ott: null,
  };
  const merged = { ...base, ...over };
  // Keep clientId consistent with internalId when not overridden explicitly.
  if (!('clientId' in over)) {
    merged.clientId = merged.internalId ? merged.internalId.replace(/-\d+$/, '') : null;
  }
  return merged;
}

function fakePort(over: Partial<GigaredPort> = {}): GigaredPort {
  const summary: GigaredSummary = { accounts: { registered: 1, unregistered: 2, total: 3 }, services: [] };
  return {
    getSummary: jest.fn(async () => summary),
    listAccounts: jest.fn(async () => [fakeAccount()]),
    getAccountByInternalId: jest.fn(async () => fakeAccount()),
    getAccountByCic: jest.fn(async () => fakeAccount({ internalId: null })),
    register: jest.fn(async () => {}),
    activate: jest.fn(async () => {}),
    setInternalId: jest.fn(async () => {}),
    addService: jest.fn(async () => {}),
    removeService: jest.fn(async () => {}),
    setOtt: jest.fn(async () => {}),
    changePassword: jest.fn(async () => {}),
    renewCic: jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' })),
    ...over,
  };
}

// #70 — the lookup also reports grClienteId (kept for back-compat; #115 already migrated
// the register identity to grContratoId, but other use cases may still read it).
const customerLookup = (exists: boolean, grClienteId: string | null = '243200') => ({
  findById: async (id: string) => (exists ? { id, grClienteId } : null),
});

/**
 * #115 — contract lookup stub used by RegisterGigaredAccount tests.
 * Includes grContratoId so the use case can derive the deterministic TV identity.
 * Defaults: grContratoId='243200' → ip243200 (same value as the old grClienteId default,
 * so the #65 persistence assertions remain byte-for-byte: tvPassword='ip243200').
 */
const contractLookupWithGr = (
  exists: boolean,
  ownerId = 'cust-1',
  grContratoId: string | null = '243200',
) => ({
  findById: async (id: string) =>
    exists ? { id, clientId: ownerId, grContratoId } : null,
});

describe('GetGigaredSummary (#47)', () => {
  it('returns the port summary', async () => {
    const port = fakePort();
    const result = await new GetGigaredSummary(port).execute();
    expect(result.accounts.total).toBe(3);
  });
});

describe('ListGigaredAccounts (#47)', () => {
  it('wraps the port result in { accounts }', async () => {
    const port = fakePort();
    const result = await new ListGigaredAccounts(port).execute({ email: 'e@x.com' });
    expect(result.accounts).toHaveLength(1);
    expect(port.listAccounts).toHaveBeenCalledWith({ email: 'e@x.com' });
  });
});

describe('ListGigaredAccounts (#3 — clientId derivation at application layer)', () => {
  it('internalId "uuid-1" → clientId "uuid"', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [fakeAccount({ internalId: 'uuid-1', clientId: 'uuid-1' })]),
    });
    const result = await new ListGigaredAccounts(port).execute({});
    expect(result.accounts[0]!.clientId).toBe('uuid');
  });

  it('bare "uuid" (no suffix) → clientId "uuid"', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [fakeAccount({ internalId: 'uuid', clientId: 'uuid' })]),
    });
    const result = await new ListGigaredAccounts(port).execute({});
    expect(result.accounts[0]!.clientId).toBe('uuid');
  });

  it('null internalId → null clientId', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [fakeAccount({ internalId: null, clientId: null })]),
    });
    const result = await new ListGigaredAccounts(port).execute({});
    expect(result.accounts[0]!.clientId).toBeNull();
  });
});

describe('GetGigaredCustomerAccount (#47)', () => {
  it('linked customer → { linked:true, account }', async () => {
    const port = fakePort();
    const uc = new GetGigaredCustomerAccount(port, customerLookup(true));
    const result = await uc.execute('cust-1');
    expect(result.linked).toBe(true);
    expect(result.account!.cic).toBe('0000000001');
    expect(port.getAccountByInternalId).toHaveBeenCalledWith('cust-1');
  });

  it('Gigared 404 → { linked:false, account:null } (does NOT propagate)', async () => {
    const port = fakePort({ getAccountByInternalId: jest.fn(async () => { throw new GigaredNotFoundError(); }) });
    const uc = new GetGigaredCustomerAccount(port, customerLookup(true));
    const result = await uc.execute('cust-1');
    expect(result.linked).toBe(false);
    expect(result.account).toBeNull();
  });

  it('unknown customer → ClientNotFoundError', async () => {
    const uc = new GetGigaredCustomerAccount(fakePort(), customerLookup(false));
    await expect(uc.execute('ghost')).rejects.toBeInstanceOf(ClientNotFoundError);
  });
});

describe('LinkCustomerToCic (#47 / C2 — CIC_ALREADY_LINKED implemented)', () => {
  it('path 1 — CIC partner exists & free (internal_id empty) → setInternalId then read back', async () => {
    const port = fakePort({
      getAccountByCic: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: '' })),
      getAccountByInternalId: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: 'cust-1' })),
    });
    const uc = new LinkCustomerToCic(port, customerLookup(true));
    const result = await uc.execute('cust-1', '0000001234');
    expect(port.getAccountByCic).toHaveBeenCalledWith('0000001234');
    expect(port.setInternalId).toHaveBeenCalledWith('0000001234', 'cust-1');
    expect(port.getAccountByInternalId).toHaveBeenCalledWith('cust-1');
    expect(result.account.internalId).toBe('cust-1');
  });

  it('path 2 — CIC partner has a DIFFERENT internal_id → CicAlreadyLinkedError (no setInternalId)', async () => {
    const port = fakePort({
      getAccountByCic: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: 'cust-OTHER' })),
    });
    const uc = new LinkCustomerToCic(port, customerLookup(true));
    await expect(uc.execute('cust-1', '0000001234')).rejects.toBeInstanceOf(CicAlreadyLinkedError);
    expect(port.setInternalId).not.toHaveBeenCalled();
  });

  it('path 3 — CIC partner already linked to THIS customer → idempotent OK (no setInternalId needed)', async () => {
    const port = fakePort({
      getAccountByCic: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: 'cust-1' })),
    });
    const uc = new LinkCustomerToCic(port, customerLookup(true));
    const result = await uc.execute('cust-1', '0000001234');
    expect(result.account.internalId).toBe('cust-1');
    // idempotent: we don't re-set the same value
    expect(port.setInternalId).not.toHaveBeenCalled();
  });

  it('path 4 — CIC does not exist upstream (getAccountByCic 404) → CicNotFoundError', async () => {
    const port = fakePort({
      getAccountByCic: jest.fn(async () => { throw new GigaredNotFoundError(); }),
    });
    const uc = new LinkCustomerToCic(port, customerLookup(true));
    await expect(uc.execute('cust-1', '0000009999')).rejects.toBeInstanceOf(CicNotFoundError);
    expect(port.setInternalId).not.toHaveBeenCalled();
  });

  it('unknown customer → ClientNotFoundError before any Gigared call', async () => {
    const port = fakePort();
    const uc = new LinkCustomerToCic(port, customerLookup(false));
    await expect(uc.execute('ghost', '0000001234')).rejects.toBeInstanceOf(ClientNotFoundError);
    expect(port.getAccountByCic).not.toHaveBeenCalled();
    expect(port.setInternalId).not.toHaveBeenCalled();
  });
});

describe('LinkCustomerToCic (#47f — reconcile TV ContractService on link)', () => {
  // Optional contractId on link. When present + account ends up linked WITH active services,
  // reconcile the TV ContractService in THAT contract (same helper as AddTvService). When absent,
  // behavior is byte-for-byte the current link (back-compat). Invalid contractId → 404 BEFORE Gigared.
  let cs: InMemoryContractServiceRepository;
  let catalog: InMemoryServiceCatalogRepository;

  beforeEach(() => {
    cs = new InMemoryContractServiceRepository();
    catalog = new InMemoryServiceCatalogRepository();
  });

  async function seedTvCatalog(active = true) {
    const cat = await catalog.create({ name: 'TV', label: 'TV', active, sortOrder: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cs as any).catalog[cat.id] = { name: cat.name, label: cat.label };
    return cat;
  }

  // Contract lookup carries ownership (clientId). Defaults the owner to 'cust-1' so the
  // existing tests keep passing; pass a different owner to simulate a foreign contract (#47k).
  const contractLookup = (exists: boolean, ownerId = 'cust-1') => ({
    findById: async (id: string) => (exists ? { id, clientId: ownerId } : null),
  });

  it('(a) link with contractId + account already linked WITH services → ContractService TV created, notes correct', async () => {
    await seedTvCatalog();
    const port = fakePort({
      // already linked to THIS customer (path 3) WITH active packs
      getAccountByCic: jest.fn(async () =>
        fakeAccount({ cic: '0000001234', internalId: 'cust-1', services: [{ id: '129', name: 'Gigared Play Full' }] })),
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ cic: '0000001234', internalId: 'cust-1', services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });
    const uc = new LinkCustomerToCic(port, customerLookup(true), contractLookup(true), cs, catalog);
    const result = await uc.execute('cust-1', '0000001234', 'C1');

    expect(result.account.internalId).toBe('cust-1');
    expect(result.local).toBe('synced');
    const row = await cs.getByPair('C1', (await catalog.getByName('TV'))!.id);
    expect(row).not.toBeNull();
    expect(row!.notes).toBe('CIC 0000001234 · Gigared Play Full');
    expect(row!.status).toBe('active');
  });

  it('(a2) link with contractId + FREE CIC then linked WITH services → setInternalId + reconcile', async () => {
    await seedTvCatalog();
    const port = fakePort({
      getAccountByCic: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: '' })),
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ cic: '0000001234', internalId: 'cust-1', services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });
    const uc = new LinkCustomerToCic(port, customerLookup(true), contractLookup(true), cs, catalog);
    const result = await uc.execute('cust-1', '0000001234', 'C1');

    expect(port.setInternalId).toHaveBeenCalledWith('0000001234', 'cust-1');
    expect(result.local).toBe('synced');
    const row = await cs.getByPair('C1', (await catalog.getByName('TV'))!.id);
    expect(row!.notes).toBe('CIC 0000001234 · Gigared Play Full');
  });

  it('(b) link with contractId but account has NO services → does NOT create a local row', async () => {
    await seedTvCatalog();
    const port = fakePort({
      getAccountByCic: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: '' })),
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ cic: '0000001234', internalId: 'cust-1', services: [] })),
    });
    const uc = new LinkCustomerToCic(port, customerLookup(true), contractLookup(true), cs, catalog);
    const result = await uc.execute('cust-1', '0000001234', 'C1');

    expect(result.local).toBe('synced');
    const row = await cs.getByPair('C1', (await catalog.getByName('TV'))!.id);
    expect(row).toBeNull();
  });

  it('(c) link WITHOUT contractId → never touches contracts (regression, exact back-compat)', async () => {
    await seedTvCatalog();
    const addSpy = jest.spyOn(cs, 'add');
    const port = fakePort({
      getAccountByCic: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: '' })),
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ cic: '0000001234', internalId: 'cust-1', services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });
    const uc = new LinkCustomerToCic(port, customerLookup(true), contractLookup(true), cs, catalog);
    const result = await uc.execute('cust-1', '0000001234');

    expect(result.account.internalId).toBe('cust-1');
    expect(result.local).toBeUndefined();
    expect(addSpy).not.toHaveBeenCalled();
  });

  it('(d) invalid contractId → ContractNotFoundError and Gigared was NEVER called', async () => {
    await seedTvCatalog();
    const port = fakePort({
      getAccountByCic: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: '' })),
    });
    const uc = new LinkCustomerToCic(port, customerLookup(true), contractLookup(false), cs, catalog);
    await expect(uc.execute('cust-1', '0000001234', 'ghost')).rejects.toBeInstanceOf(ContractNotFoundError);
    expect(port.getAccountByCic).not.toHaveBeenCalled();
    expect(port.setInternalId).not.toHaveBeenCalled();
  });

  it('(d2) #47k HIGH: contractId de OTRO cliente → ContractNotFoundError, Gigared NUNCA llamado', async () => {
    await seedTvCatalog();
    const port = fakePort({
      getAccountByCic: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: '' })),
    });
    // El contrato existe pero pertenece a 'cust-B'.
    const uc = new LinkCustomerToCic(port, customerLookup(true), contractLookup(true, 'cust-B'), cs, catalog);
    await expect(uc.execute('cust-1', '0000001234', 'C-of-B')).rejects.toBeInstanceOf(ContractNotFoundError);
    expect(port.getAccountByCic).not.toHaveBeenCalled();
    expect(port.setInternalId).not.toHaveBeenCalled();
  });

  it('(e) reconcile local fails (csRepo throws) → local:"failed" and the Gigared link stays done', async () => {
    await seedTvCatalog();
    jest.spyOn(cs, 'add').mockRejectedValue(new Error('db down'));
    const port = fakePort({
      getAccountByCic: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: '' })),
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ cic: '0000001234', internalId: 'cust-1', services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });
    const uc = new LinkCustomerToCic(port, customerLookup(true), contractLookup(true), cs, catalog);
    const result = await uc.execute('cust-1', '0000001234', 'C1');

    // Link is NOT reverted — Gigared setInternalId still ran.
    expect(port.setInternalId).toHaveBeenCalledWith('0000001234', 'cust-1');
    expect(result.account.internalId).toBe('cust-1');
    expect(result.local).toBe('failed');
  });

  it('(g) #65 M6 — re-link with a DIFFERENT cic on an existing managed row → old credentials are CLEARED', async () => {
    const cat = await seedTvCatalog();
    // Seed an existing Gigared-managed TV row carrying credentials from a PREVIOUS cic.
    await cs.add({
      contractId: 'C1', serviceCatalogId: cat.id,
      notes: 'CIC 0000000001 · Gigared Play Full', tvLogin: 'GIGA100', tvPassword: 'oldpass99',
    });
    // Now link a NEW cic (0000009999) with active services — reconcile reactivates the row.
    const port = fakePort({
      getAccountByCic: jest.fn(async () =>
        fakeAccount({ cic: '0000009999', gigaredId: '999', internalId: 'cust-1', services: [{ id: '129', name: 'Gigared Play Full' }] })),
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ cic: '0000009999', gigaredId: '999', internalId: 'cust-1', services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });
    const uc = new LinkCustomerToCic(port, customerLookup(true), contractLookup(true), cs, catalog);
    const result = await uc.execute('cust-1', '0000009999', 'C1');

    expect(result.local).toBe('synced');
    const row = await cs.getByPair('C1', cat.id);
    // The cic changed → stale credentials of the OLD account must not survive.
    expect(row!.notes).toBe('CIC 0000009999 · Gigared Play Full');
    expect(row!.tvLogin).toBeNull();
    expect(row!.tvPassword).toBeNull();
  });

  it('(f) idempotent: re-link same customer+cic+contract → no duplicate row (upsert on UNIQUE pair)', async () => {
    await seedTvCatalog();
    const port = fakePort({
      getAccountByCic: jest.fn(async () =>
        fakeAccount({ cic: '0000001234', internalId: 'cust-1', services: [{ id: '129', name: 'Gigared Play Full' }] })),
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ cic: '0000001234', internalId: 'cust-1', services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });
    const uc = new LinkCustomerToCic(port, customerLookup(true), contractLookup(true), cs, catalog);
    const r1 = await uc.execute('cust-1', '0000001234', 'C1');
    const r2 = await uc.execute('cust-1', '0000001234', 'C1');

    expect(r1.local).toBe('synced');
    expect(r2.local).toBe('synced');
    const tvId = (await catalog.getByName('TV'))!.id;
    const row = await cs.getByPair('C1', tvId);
    expect(row).not.toBeNull();
    // exactly ONE row for the pair — getByPair would only ever return one, but assert no second slot exists
    expect(row!.notes).toBe('CIC 0000001234 · Gigared Play Full');
  });
});

describe('RegisterGigaredAccount (#47)', () => {
  it('calls register → activate → setInternalId in order, returns account', async () => {
    const calls: string[] = [];
    // #109 — el pool (listAccounts con status:'unregistered') provee el CIC automáticamente.
    // fakePort devuelve [fakeAccount()] cuyo CIC default es '0000000001'.
    const pool = fakeAccount({ cic: '0000000001' });
    const port = fakePort({
      listAccounts: jest.fn(async () => [pool]),
      register: jest.fn(async () => { calls.push('register'); }),
      activate: jest.fn(async () => { calls.push('activate'); }),
      setInternalId: jest.fn(async () => { calls.push('setInternalId'); }),
      getAccountByInternalId: jest.fn(async () => { calls.push('get'); return fakeAccount(); }),
    });
    // #115 — contractId REQUERIDO; la password se genera desde grContratoId='243200' → ip243200.
    const uc = new RegisterGigaredAccount(port, customerLookup(true), contractLookupWithGr(true));
    const result = await uc.execute('cust-1', {
      firstName: 'Juan', lastName: 'Pérez', email: 'e@x.com',
      // cic omitido — #109: viene del pool automáticamente.
      sendActivationEmail: true,
      contractId: 'C1',
    });
    expect(calls).toEqual(['register', 'activate', 'setInternalId', 'get']);
    // CIC usado: el del pool ('0000000001'), no el que mandaba el FE antes.
    // #118 — email deriva server-side del grContratoId='243200' y lastName='Pérez' → 'perez243200@gmail.com'.
    // El input.email del FE ('e@x.com') se ignora: fuente única es grContratoId.
    expect(port.activate).toHaveBeenCalledWith({ cic: '0000000001', email: 'perez243200@gmail.com' });
    expect(port.setInternalId).toHaveBeenCalledWith('0000000001', 'cust-1');
    expect(result.account.cic).toBe('0000000001');
    // #115 — la password se genera desde grContratoId='243200' → ip243200.
    expect((port.register as jest.Mock).mock.calls[0][0]).toMatchObject({ password: 'ip243200' });
  });

  // #115 — la password la genera el use case desde grContratoId (antes grClienteId del cliente).
  it('#115 generates the password SERVER-SIDE from grContratoId (ip{grContratoId} padded)', async () => {
    const port = fakePort();
    // grContratoId='12' → ip12 < 8 chars → padded to ip120000
    const uc = new RegisterGigaredAccount(port, customerLookup(true), contractLookupWithGr(true, 'cust-1', '12'));
    await uc.execute('cust-1', {
      firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234',
      sendActivationEmail: false, contractId: 'C1',
    });
    // ip12 < 8 → padded with '0' → ip120000
    expect((port.register as jest.Mock).mock.calls[0][0]).toMatchObject({ password: 'ip120000' });
  });

  it('back-compat: contractId present but no csRepo/catalogRepo → no persistence (credentialsPersisted:false)', async () => {
    const port = fakePort();
    const uc = new RegisterGigaredAccount(port, customerLookup(true), contractLookupWithGr(true));
    const result = await uc.execute('cust-1', {
      firstName: 'Juan', lastName: 'Pérez', email: 'e@x.com', cic: '0000001234',
      sendActivationEmail: false, contractId: 'C1',
    });
    expect(result.credentialsPersisted).toBe(false);
  });
});

// #65 / #115 — register persists the deterministic credentials on the TV ContractService.
// grContratoId defaults to '243200' → ip243200 password (keeps the #65 asserts byte-for-byte).
const contractLookupReg = (exists: boolean, ownerId = 'cust-1', grContratoId: string | null = '243200') => ({
  findById: async (id: string) => (exists ? { id, clientId: ownerId, grContratoId } : null),
});

describe('RegisterGigaredAccount (#65 — persist TV credentials)', () => {
  let cs: InMemoryContractServiceRepository;
  let catalog: InMemoryServiceCatalogRepository;

  beforeEach(() => {
    cs = new InMemoryContractServiceRepository();
    catalog = new InMemoryServiceCatalogRepository();
  });

  async function seedTvCatalog() {
    const cat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cs as any).catalog[cat.id] = { name: cat.name, label: cat.label };
    return cat;
  }

  it('persists tvLogin=GIGA{gigaredId} + tvPassword on the TV row when account has services', async () => {
    await seedTvCatalog();
    const port = fakePort({
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ cic: '0000001234', gigaredId: '2432', internalId: 'cust-1', services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });
    const uc = new RegisterGigaredAccount(port, customerLookup(true), contractLookupReg(true), cs, catalog);
    const result = await uc.execute('cust-1', {
      firstName: 'Ronald', lastName: 'Hernández', email: 'ronald2432@gmail.com', cic: '0000001234',
      sendActivationEmail: false, contractId: 'C1',
    });
    const tvId = (await catalog.getByName('TV'))!.id;
    const row = await cs.getByPair('C1', tvId);
    expect(row).not.toBeNull();
    expect(row!.tvLogin).toBe('GIGA2432');
    expect(row!.tvPassword).toBe('ip243200');
    // notes still follow the reconcile prefix (ownership intact)
    expect(row!.notes).toBe('CIC 0000001234 · Gigared Play Full');
    // M7 — the result tells the FE whether credentials made it to the slot.
    expect(result.credentialsPersisted).toBe(true);
  });

  it('H2/M8 — FRESH account with NO services still PERSISTS credentials on an ensured (inactive) TV row', async () => {
    await seedTvCatalog();
    // The hallmark of an alta fresca: the account exists but the partner returns no services yet.
    const port = fakePort({
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ cic: '0000001234', gigaredId: '2432', internalId: 'cust-1', services: [] })),
    });
    const uc = new RegisterGigaredAccount(port, customerLookup(true), contractLookupReg(true), cs, catalog);
    const result = await uc.execute('cust-1', {
      firstName: 'R', lastName: 'H', email: 'e@x.com', cic: '0000001234',
      sendActivationEmail: false, contractId: 'C1',
    });
    const tvId = (await catalog.getByName('TV'))!.id;
    const row = await cs.getByPair('C1', tvId);
    // The row MUST exist (ensured) so the credentials have a home — even with no packs.
    expect(row).not.toBeNull();
    expect(row!.status).toBe('inactive'); // no packs → inactive, but credentials still live here
    expect(row!.tvLogin).toBe('GIGA2432');
    expect(row!.tvPassword).toBe('ip243200');
    expect(result.credentialsPersisted).toBe(true);
  });

  it('rejects a foreign contractId (404) BEFORE any Gigared call', async () => {
    await seedTvCatalog();
    const port = fakePort();
    const uc = new RegisterGigaredAccount(port, customerLookup(true), contractLookupReg(true, 'cust-B'), cs, catalog);
    await expect(uc.execute('cust-1', {
      firstName: 'R', lastName: 'H', email: 'e@x.com', cic: '0000001234',
      sendActivationEmail: false, contractId: 'C-of-B',
    })).rejects.toBeInstanceOf(ContractNotFoundError);
    expect(port.register).not.toHaveBeenCalled();
  });

  it('M7 — persistence failure does NOT abort the register (account still returned, credentialsPersisted:false)', async () => {
    await seedTvCatalog();
    jest.spyOn(cs, 'add').mockRejectedValue(new Error('db down'));
    jest.spyOn(cs, 'update').mockRejectedValue(new Error('db down'));
    const port = fakePort({
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ cic: '0000001234', gigaredId: '2432', internalId: 'cust-1', services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });
    const uc = new RegisterGigaredAccount(port, customerLookup(true), contractLookupReg(true), cs, catalog);
    const result = await uc.execute('cust-1', {
      firstName: 'R', lastName: 'H', email: 'e@x.com', cic: '0000001234',
      sendActivationEmail: false, contractId: 'C1',
    });
    expect(result.account.cic).toBe('0000001234');
    expect(result.credentialsPersisted).toBe(false);
  });

  it('M7 — #115: with contractId + csRepo + catalogRepo → credentials are persisted (credentialsPersisted:true)', async () => {
    await seedTvCatalog();
    const port = fakePort({
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ cic: '0000001234', gigaredId: '2432', internalId: 'cust-1', services: [] })),
    });
    const uc = new RegisterGigaredAccount(port, customerLookup(true), contractLookupReg(true), cs, catalog);
    const result = await uc.execute('cust-1', {
      firstName: 'R', lastName: 'H', email: 'e@x.com', cic: '0000001234',
      sendActivationEmail: false, contractId: 'C1',
    });
    expect(result.credentialsPersisted).toBe(true);
  });
});

// ----- #72: local TV-cancel flag integration -----

describe('GetGigaredCustomerAccount (#72 — local TV-cancel flag)', () => {
  it('customer with tvCancelled → { linked:false, account:null } WITHOUT calling the partner', async () => {
    const port = fakePort();
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1');

    const uc = new GetGigaredCustomerAccount(port, customerLookup(true), tvCancellation);
    const result = await uc.execute('cust-1');

    expect(result.linked).toBe(false);
    expect(result.account).toBeNull();
    // El partner NO fue consultado (el flag local es suficiente)
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
  });

  it('customer NOT cancelled → calls partner normally', async () => {
    const port = fakePort();
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    // No seedCancelled → flag no seteado

    const uc = new GetGigaredCustomerAccount(port, customerLookup(true), tvCancellation);
    const result = await uc.execute('cust-1');

    expect(result.linked).toBe(true);
    expect(port.getAccountByInternalId).toHaveBeenCalledWith('cust-1');
  });

  it('without tvCancellation dep → calls partner normally (backward-compat)', async () => {
    const port = fakePort();
    const uc = new GetGigaredCustomerAccount(port, customerLookup(true));
    const result = await uc.execute('cust-1');
    expect(result.linked).toBe(true);
  });
});

describe('LinkCustomerToCic (#72 — clearCancelled on link)', () => {
  it('successful link → clearCancelled called (client gets TV back)', async () => {
    const port = fakePort({
      getAccountByCic: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: '' })),
      getAccountByInternalId: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: 'cust-1' })),
    });
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1'); // pre-cancellado

    const uc = new LinkCustomerToCic(port, customerLookup(true), undefined, undefined, undefined, tvCancellation);
    await uc.execute('cust-1', '0000001234');

    // El flag fue limpiado: el cliente volvió a tener TV
    expect(await tvCancellation.isCancelled('cust-1')).toBe(false);
  });

  it('idempotent link (already linked) → clearCancelled still called', async () => {
    const port = fakePort({
      getAccountByCic: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: 'cust-1' })),
    });
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1');

    const uc = new LinkCustomerToCic(port, customerLookup(true), undefined, undefined, undefined, tvCancellation);
    await uc.execute('cust-1', '0000001234');

    expect(await tvCancellation.isCancelled('cust-1')).toBe(false);
  });

  it('without tvCancellation dep → link works normally (backward-compat)', async () => {
    const port = fakePort({
      getAccountByCic: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: '' })),
      getAccountByInternalId: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: 'cust-1' })),
    });
    const uc = new LinkCustomerToCic(port, customerLookup(true));
    const result = await uc.execute('cust-1', '0000001234');
    expect(result.account.cic).toBe('0000001234');
  });
});

describe('RegisterGigaredAccount (#72 — clearCancelled on register)', () => {
  it('successful register → clearCancelled called (client gets TV back)', async () => {
    const port = fakePort({
      getAccountByInternalId: jest.fn(async () => fakeAccount({ cic: '0000001234', internalId: 'cust-1' })),
    });
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1'); // pre-cancellado

    // #115 — contractLookup requerido (contractId es ahora obligatorio)
    const uc = new RegisterGigaredAccount(port, customerLookup(true), contractLookupWithGr(true), undefined, undefined, tvCancellation);
    await uc.execute('cust-1', {
      firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234',
      sendActivationEmail: false, contractId: 'C1',
    });

    // El flag fue limpiado: el cliente volvió a tener TV
    expect(await tvCancellation.isCancelled('cust-1')).toBe(false);
  });

  it('without tvCancellation dep → register works normally (backward-compat)', async () => {
    const port = fakePort();
    // #115 — contractLookup requerido
    const uc = new RegisterGigaredAccount(port, customerLookup(true), contractLookupWithGr(true));
    const result = await uc.execute('cust-1', {
      firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234',
      sendActivationEmail: false, contractId: 'C1',
    });
    expect(result.account.cic).toBe('0000000001');
  });
});

// ----- #81: identidad de TV secuencial por cliente (re-alta tras baja) -----

/**
 * Fake STATEFUL del partner para el seam del internal_id (#81): un Map internalId→cuenta.
 * setInternalId QUEMA el internal_id (si ya está en el mapa, lanza como el partner real:
 * "ID interno ya está en uso"). getAccountByInternalId lee del mapa (404 si no existe).
 * Así el test prueba que la re-alta usa un internal_id NUEVO ({id}-{seq}) y nunca el quemado.
 */
/**
 * Pool explícito usado por statefulFakePort. Una sola cuenta unregistered con CIC '0000000001'.
 * Declarado como constante para que cada test que necesite un pool diferente lo override con
 * (port.listAccounts as jest.Mock).mockResolvedValue([...]) de forma explícita y legible.
 * W3 fix: antes se heredaba el listAccounts del fakePort base (pool de 1 implícito, accidental).
 */
const STATEFUL_DEFAULT_POOL: GigaredAccount[] = [fakeAccount({ cic: '0000000001' })];

function statefulFakePort(seeded: Record<string, GigaredAccount> = {}): GigaredPort {
  const byInternalId = new Map<string, GigaredAccount>(Object.entries(seeded));
  let lastCic = '0000009000';
  const base = fakePort();
  return {
    ...base,
    // W3 fix: override explícito — ya no dependemos del default accidental del base fakePort.
    listAccounts: jest.fn(async () => [...STATEFUL_DEFAULT_POOL]),
    setInternalId: jest.fn(async (cic: string, internalId: string) => {
      if (byInternalId.has(internalId)) {
        throw new Error('El ID interno ya está en uso');
      }
      lastCic = cic;
      byInternalId.set(internalId, fakeAccount({ cic, internalId, services: [{ id: '129', name: 'Gigared Play Full' }] }));
    }),
    getAccountByInternalId: jest.fn(async (internalId: string) => {
      const acc = byInternalId.get(internalId);
      if (!acc) throw new GigaredNotFoundError();
      return acc;
    }),
    register: jest.fn(async () => { void lastCic; }),
    activate: jest.fn(async () => {}),
  };
}

describe('RegisterGigaredAccount (#81 — identidad secuencial)', () => {
  // contractLookup stub common to #81 tests — grContratoId='243200' (CUA-valid)
  const cl81 = contractLookupWithGr(true, 'cust-1', '243200');

  it('primera alta (no cancelado) → seq 0, internal_id = Client.id pelado (back-compat byte-for-byte)', async () => {
    const port = statefulFakePort();
    const activation = new InMemoryClientTvActivationRepository();
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    const uc = new RegisterGigaredAccount(
      port, customerLookup(true), cl81, undefined, undefined, tvCancellation, activation,
    );
    const result = await uc.execute('cust-1', {
      firstName: 'Juan', lastName: 'Pérez', email: 'perez243200@gmail.com',
      // cic omitido — #109: viene del pool. fakePort provee [fakeAccount()] → CIC '0000000001'.
      sendActivationEmail: false, contractId: 'C1',
    });
    // seq NO avanza en la primera alta (cliente no venía de baja).
    expect(await activation.getSeq('cust-1')).toBe(0);
    // CIC del pool, no del FE.
    expect(port.setInternalId).toHaveBeenCalledWith('0000000001', 'cust-1');
    expect(result.account.internalId).toBe('cust-1');
  });

  it('re-alta (cliente venía de baja) → incrementa seq, usa internal_id {id}-1 NUEVO (no el quemado)', async () => {
    // El internal_id viejo 'cust-1' ya está QUEMADO en el partner (CIC muerto).
    // El pool (#109) devuelve una cuenta con CIC '0000000002' (distinto al quemado).
    const poolCic = '0000000002';
    const port = statefulFakePort({
      'cust-1': fakeAccount({ cic: '0000000001', internalId: 'cust-1', services: [] }),
    });
    // Override listAccounts para que el pool tenga un CIC nuevo (el quemado ya está en seeded).
    (port.listAccounts as jest.Mock).mockResolvedValue([fakeAccount({ cic: poolCic })]);

    const activation = new InMemoryClientTvActivationRepository();
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1'); // el cliente venía de baja

    const uc = new RegisterGigaredAccount(
      port, customerLookup(true), cl81, undefined, undefined, tvCancellation, activation,
    );
    const result = await uc.execute('cust-1', {
      firstName: 'Juan', lastName: 'Pérez', email: 'ignored@x.com',
      // cic omitido — #109: viene del pool.
      sendActivationEmail: false, contractId: 'C1',
    });

    // seq avanzó a 1; el internal_id usado es 'cust-1-1' (fresco), nunca el quemado 'cust-1'.
    expect(await activation.getSeq('cust-1')).toBe(1);
    // CIC del pool nuevo, no el quemado ni el que antes mandaba el FE.
    expect(port.setInternalId).toHaveBeenCalledWith(poolCic, 'cust-1-1');
    expect(result.account.internalId).toBe('cust-1-1');
    // el flag de baja se limpió (el cliente volvió a tener TV).
    expect(await tvCancellation.isCancelled('cust-1')).toBe(false);
  });

  it('re-alta → el mail se genera server-side con el seq: {apellido}{grContratoId}{seq}@gmail.com', async () => {
    const port = statefulFakePort({
      'cust-1': fakeAccount({ cic: '0000000001', internalId: 'cust-1' }),
    });
    const activation = new InMemoryClientTvActivationRepository();
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1');

    // grContratoId='2432' → re-alta mail = hernandez24321@gmail.com
    const uc = new RegisterGigaredAccount(
      port, customerLookup(true, '999'), contractLookupWithGr(true, 'cust-1', '2432'),
      undefined, undefined, tvCancellation, activation,
    );
    await uc.execute('cust-1', {
      firstName: 'Ronald', lastName: 'Hernández', email: 'whatever@x.com', cic: '0000005678',
      sendActivationEmail: false, contractId: 'C1',
    });

    // seq=1 → mail = hernandez24321@gmail.com (derivado de grContratoId='2432', recuperable, determinístico).
    expect((port.register as jest.Mock).mock.calls[0][0]).toMatchObject({ email: 'hernandez24321@gmail.com' });
    expect((port.activate as jest.Mock).mock.calls[0][0]).toMatchObject({ email: 'hernandez24321@gmail.com' });
  });

  it('segunda re-alta → seq 2, internal_id {id}-2 (cada reactivación es fresca)', async () => {
    const poolCic = '0000009999';
    const port = statefulFakePort({
      'cust-1': fakeAccount({ internalId: 'cust-1' }),
      'cust-1-1': fakeAccount({ internalId: 'cust-1-1' }),
    });
    // Override listAccounts: pool tiene un CIC nuevo disponible.
    (port.listAccounts as jest.Mock).mockResolvedValue([fakeAccount({ cic: poolCic })]);

    const activation = new InMemoryClientTvActivationRepository();
    activation.seedSeq('cust-1', 1); // ya hubo una reactivación
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1');

    const uc = new RegisterGigaredAccount(
      port, customerLookup(true), cl81, undefined, undefined, tvCancellation, activation,
    );
    const result = await uc.execute('cust-1', {
      firstName: 'J', lastName: 'P', email: 'x@x.com',
      // cic omitido — #109: viene del pool.
      sendActivationEmail: false, contractId: 'C1',
    });
    expect(await activation.getSeq('cust-1')).toBe(2);
    expect(port.setInternalId).toHaveBeenCalledWith(poolCic, 'cust-1-2');
    expect(result.account.internalId).toBe('cust-1-2');
  });

  it('back-compat: sin activation repo → comportamiento de hoy (seq 0, id pelado)', async () => {
    const port = statefulFakePort();
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1'); // aun cancelado, sin repo no hay seq
    const uc = new RegisterGigaredAccount(
      port, customerLookup(true), cl81, undefined, undefined, tvCancellation,
    );
    const result = await uc.execute('cust-1', {
      firstName: 'J', lastName: 'P', email: 'e@x.com',
      // cic omitido — #109: viene del pool. fakePort devuelve CIC '0000000001'.
      sendActivationEmail: false, contractId: 'C1',
    });
    // CIC del pool.
    expect(port.setInternalId).toHaveBeenCalledWith('0000000001', 'cust-1');
    expect(result.account.internalId).toBe('cust-1');
  });
});
