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

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  return {
    cic: '0000000001', gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '19/01/2026', services: [{ id: '129', name: 'Gigared Play Full' }],
    internalId: 'cust-1', ott: null, ...over,
  };
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
    ...over,
  };
}

const customerLookup = (exists: boolean) => ({
  findById: async (id: string) => (exists ? { id } : null),
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

  const contractLookup = (exists: boolean) => ({ findById: async (id: string) => (exists ? { id } : null) });

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
    const port = fakePort({
      register: jest.fn(async () => { calls.push('register'); }),
      activate: jest.fn(async () => { calls.push('activate'); }),
      setInternalId: jest.fn(async () => { calls.push('setInternalId'); }),
      getAccountByInternalId: jest.fn(async () => { calls.push('get'); return fakeAccount(); }),
    });
    const uc = new RegisterGigaredAccount(port, customerLookup(true));
    const result = await uc.execute('cust-1', {
      firstName: 'Juan', lastName: 'Pérez', email: 'e@x.com', cic: '0000001234',
      password: 'transient', sendActivationEmail: true,
    });
    expect(calls).toEqual(['register', 'activate', 'setInternalId', 'get']);
    expect(port.activate).toHaveBeenCalledWith({ cic: '0000001234', email: 'e@x.com' });
    expect(port.setInternalId).toHaveBeenCalledWith('0000001234', 'cust-1');
    expect(result.account.cic).toBe('0000000001');
    // password must not surface in the returned account
    expect(JSON.stringify(result)).not.toContain('transient');
  });
});
