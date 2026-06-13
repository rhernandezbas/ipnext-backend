/**
 * #47 — AddTvService + reconcile + RemoveTvService + SetOttStatus.
 * Reconcile (D6): after each mutation, read the Gigared account; if it has services,
 * upsert the local TV ContractService with notes "CIC {cic} · {names}"; if empty, delete.
 * D7: gigared rejects the add but the account ALREADY has the serviceId → treat as success.
 * 207: gigared ok but local reconcile throws → { gigared:'ok', local:'failed' }.
 */
import { AddTvService } from '@application/use-cases/gigared/AddTvService';
import { RemoveTvService } from '@application/use-cases/gigared/RemoveTvService';
import { SetOttStatus } from '@application/use-cases/gigared/SetOttStatus';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import { GigaredRejectedError } from '@domain/errors/gigared';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { TvCatalogMissingError } from '@domain/errors/gigared';

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  const base: GigaredAccount = {
    cic: '0000000001', gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '2026-01-19', services: [], internalId: 'cust-1', clientId: 'cust-1', ott: null,
  };
  const merged = { ...base, ...over };
  if (!('clientId' in over)) {
    merged.clientId = merged.internalId ? merged.internalId.replace(/-\d+$/, '') : null;
  }
  return merged;
}

function fakePort(over: Partial<GigaredPort> = {}): GigaredPort {
  return {
    getSummary: jest.fn(),
    listAccounts: jest.fn(),
    getAccountByInternalId: jest.fn(async () => fakeAccount()),
    getAccountByCic: jest.fn(async () => fakeAccount()),
    register: jest.fn(), activate: jest.fn(), setInternalId: jest.fn(),
    addService: jest.fn(async () => {}),
    removeService: jest.fn(async () => {}),
    setOtt: jest.fn(async () => {}),
    changePassword: jest.fn(async () => {}),
    renewCic: jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' })),
    ...over,
  };
}

// Customer lookup: existence only.
const lookup = (exists: boolean) => ({ findById: async (id: string) => (exists ? { id } : null) });
// Contract lookup: carries ownership (clientId). Defaults the owner to 'cust-1' so the
// existing tests keep passing; pass a different owner to simulate a foreign contract (#47k).
const contractLookup = (exists: boolean, ownerId = 'cust-1') => ({
  findById: async (id: string) => (exists ? { id, clientId: ownerId } : null),
});

async function seedTvCatalog(catalog: InMemoryServiceCatalogRepository, cs: InMemoryContractServiceRepository, active = true) {
  const cat = await catalog.create({ name: 'TV', label: 'TV', active, sortOrder: 0 });
  // mirror into the cs repo's catalog join map (in-memory seam)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (cs as any).catalog[cat.id] = { name: cat.name, label: cat.label };
  return cat;
}

describe('AddTvService (#47)', () => {
  let cs: InMemoryContractServiceRepository;
  let catalog: InMemoryServiceCatalogRepository;
  beforeEach(() => {
    cs = new InMemoryContractServiceRepository();
    catalog = new InMemoryServiceCatalogRepository();
  });

  it('happy path: gigared add + local CS with notes "CIC 0000000001 · Gigared Play Full"', async () => {
    await seedTvCatalog(catalog, cs);
    const port = fakePort({
      addService: jest.fn(async () => {}),
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });
    const uc = new AddTvService(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1', serviceId: '129' });

    expect(result).toMatchObject({ gigared: 'ok', local: 'ok' });
    expect(port.addService).toHaveBeenCalledWith('cust-1', '129');
    const created = await cs.getById(result.contractServiceId!);
    expect(created!.notes).toBe('CIC 0000000001 · Gigared Play Full');
  });

  it('second service → updates the SAME local row notes (no duplicate)', async () => {
    await seedTvCatalog(catalog, cs);
    const port = fakePort({
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ services: [
          { id: '129', name: 'Gigared Play Full' },
          { id: '39', name: 'Pack Todo Futbol' },
        ] })),
    });
    const uc = new AddTvService(port, cs, catalog, contractLookup(true), lookup(true));
    // first add seeds the row
    const r1 = await uc.execute('cust-1', { contractId: 'C1', serviceId: '129' });
    const r2 = await uc.execute('cust-1', { contractId: 'C1', serviceId: '39' });
    expect(r2.local).toBe('ok');
    expect(r2.contractServiceId).toBe(r1.contractServiceId); // same row
    const row = await cs.getById(r2.contractServiceId!);
    expect(row!.notes).toBe('CIC 0000000001 · Gigared Play Full · Pack Todo Futbol');
  });

  it('D7: gigared rejects add but account already has the serviceId → continues to reconcile', async () => {
    await seedTvCatalog(catalog, cs);
    const port = fakePort({
      addService: jest.fn(async () => { throw new GigaredRejectedError('Already', 'service already assigned'); }),
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });
    const uc = new AddTvService(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1', serviceId: '129' });
    expect(result.gigared).toBe('ok');
    expect(result.local).toBe('ok');
  });

  it('D7 negative: gigared rejects AND account does NOT have the serviceId → rethrows', async () => {
    await seedTvCatalog(catalog, cs);
    const port = fakePort({
      addService: jest.fn(async () => { throw new GigaredRejectedError('Bad', 'invalid service'); }),
      getAccountByInternalId: jest.fn(async () => fakeAccount({ services: [] })),
    });
    const uc = new AddTvService(port, cs, catalog, contractLookup(true), lookup(true));
    await expect(uc.execute('cust-1', { contractId: 'C1', serviceId: '999' }))
      .rejects.toBeInstanceOf(GigaredRejectedError);
  });

  it('reconcile fails (csRepo throws) → 207 shape { gigared:ok, local:failed }', async () => {
    await seedTvCatalog(catalog, cs);
    jest.spyOn(cs, 'add').mockRejectedValue(new Error('db down'));
    const port = fakePort({
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });
    const uc = new AddTvService(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1', serviceId: '129' });
    expect(result.gigared).toBe('ok');
    expect(result.local).toBe('failed');
    expect(result.localError).toContain('db down');
  });

  it('TV catalog missing/inactive → TvCatalogMissingError (before touching gigared)', async () => {
    await seedTvCatalog(catalog, cs, false); // inactive
    const port = fakePort();
    const uc = new AddTvService(port, cs, catalog, contractLookup(true), lookup(true));
    await expect(uc.execute('cust-1', { contractId: 'C1', serviceId: '129' }))
      .rejects.toBeInstanceOf(TvCatalogMissingError);
    expect(port.addService).not.toHaveBeenCalled();
  });

  it('unknown customer → ClientNotFoundError', async () => {
    await seedTvCatalog(catalog, cs);
    const uc = new AddTvService(fakePort(), cs, catalog, contractLookup(true), lookup(false));
    await expect(uc.execute('ghost', { contractId: 'C1', serviceId: '129' }))
      .rejects.toBeInstanceOf(ClientNotFoundError);
  });

  it('unknown contract → ContractNotFoundError', async () => {
    await seedTvCatalog(catalog, cs);
    const uc = new AddTvService(fakePort(), cs, catalog, contractLookup(false), lookup(true));
    await expect(uc.execute('cust-1', { contractId: 'ghost', serviceId: '129' }))
      .rejects.toBeInstanceOf(ContractNotFoundError);
  });

  it('#47k HIGH: contract belongs to ANOTHER customer → ContractNotFoundError, no Gigared call', async () => {
    await seedTvCatalog(catalog, cs);
    const port = fakePort();
    const uc = new AddTvService(port, cs, catalog, contractLookup(true, 'cust-B'), lookup(true));
    await expect(uc.execute('cust-1', { contractId: 'C-of-B', serviceId: '129' }))
      .rejects.toBeInstanceOf(ContractNotFoundError);
    expect(port.addService).not.toHaveBeenCalled();
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
  });
});

describe('RemoveTvService (#47)', () => {
  let cs: InMemoryContractServiceRepository;
  let catalog: InMemoryServiceCatalogRepository;
  beforeEach(() => {
    cs = new InMemoryContractServiceRepository();
    catalog = new InMemoryServiceCatalogRepository();
  });

  it('H1: removing the last service → reconcile INACTIVATES the row (never deletes)', async () => {
    const cat = await seedTvCatalog(catalog, cs);
    // pre-seed a Gigared-managed local TV row (notes start with "CIC ")
    const row = await cs.add({ contractId: 'C1', serviceCatalogId: cat.id, notes: 'CIC 0000000001 · Gigared Play Full' });
    const port = fakePort({
      removeService: jest.fn(async () => {}),
      getAccountByInternalId: jest.fn(async () => fakeAccount({ services: [] })), // none left
    });
    const uc = new RemoveTvService(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1', serviceId: '129' });
    expect(port.removeService).toHaveBeenCalledWith('cust-1', '129');
    expect(result.local).toBe('ok');
    // Row STILL exists but is now inactive — history is preserved, not destroyed.
    const after = await cs.getById(row.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('inactive');
  });

  it('H2: a manually-created TV row (notes NULL, not Gigared-managed) is NEVER touched on empty', async () => {
    const cat = await seedTvCatalog(catalog, cs);
    // UI of #42 created this row by hand: notes do NOT start with "CIC "
    const manual = await cs.add({ contractId: 'C1', serviceCatalogId: cat.id, notes: null });
    const port = fakePort({
      getAccountByInternalId: jest.fn(async () => fakeAccount({ services: [] })),
    });
    const uc = new RemoveTvService(port, cs, catalog, contractLookup(true), lookup(true));
    await uc.execute('cust-1', { contractId: 'C1', serviceId: '129' });
    const after = await cs.getById(manual.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('active'); // untouched — still active
    expect(after!.notes).toBeNull();
  });

  it('H2: a manually-created TV row (notes not "CIC ...") is NEVER updated when services exist', async () => {
    const cat = await seedTvCatalog(catalog, cs);
    const manual = await cs.add({ contractId: 'C1', serviceCatalogId: cat.id, notes: 'plan manual UI #42' });
    const port = fakePort({
      getAccountByInternalId: jest.fn(async () => fakeAccount({ services: [{ id: '39', name: 'Pack Todo Futbol' }] })),
    });
    const uc = new AddTvService(port, cs, catalog, contractLookup(true), lookup(true));
    await uc.execute('cust-1', { contractId: 'C1', serviceId: '39' });
    const after = await cs.getById(manual.id);
    // The manual row owns the (contract, TV) slot and is left alone — reconcile won't
    // overwrite a row it doesn't manage (UNIQUE pair → it cannot create a second one).
    expect(after!.notes).toBe('plan manual UI #42');
    expect(after!.status).toBe('active');
  });

  it('removing one of several → Gigared-managed row kept, notes updated, stays active', async () => {
    const cat = await seedTvCatalog(catalog, cs);
    const row = await cs.add({ contractId: 'C1', serviceCatalogId: cat.id, notes: 'CIC 0000000001 · old' });
    const port = fakePort({
      getAccountByInternalId: jest.fn(async () => fakeAccount({ services: [{ id: '39', name: 'Pack Todo Futbol' }] })),
    });
    const uc = new RemoveTvService(port, cs, catalog, contractLookup(true), lookup(true));
    await uc.execute('cust-1', { contractId: 'C1', serviceId: '129' });
    const after = await cs.getById(row.id);
    expect(after!.notes).toBe('CIC 0000000001 · Pack Todo Futbol');
    expect(after!.status).toBe('active');
  });

  it('#47k HIGH: contract belongs to ANOTHER customer → ContractNotFoundError, no Gigared call', async () => {
    await seedTvCatalog(catalog, cs);
    const port = fakePort();
    const uc = new RemoveTvService(port, cs, catalog, contractLookup(true, 'cust-B'), lookup(true));
    await expect(uc.execute('cust-1', { contractId: 'C-of-B', serviceId: '129' }))
      .rejects.toBeInstanceOf(ContractNotFoundError);
    expect(port.removeService).not.toHaveBeenCalled();
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
  });
});

describe('SetOttStatus (#47)', () => {
  it('enable → port.setOtt(customerId, true)', async () => {
    const port = fakePort();
    await new SetOttStatus(port, lookup(true)).execute('cust-1', true);
    expect(port.setOtt).toHaveBeenCalledWith('cust-1', true);
  });

  it('disable → port.setOtt(customerId, false)', async () => {
    const port = fakePort();
    await new SetOttStatus(port, lookup(true)).execute('cust-1', false);
    expect(port.setOtt).toHaveBeenCalledWith('cust-1', false);
  });

  it('unknown customer → ClientNotFoundError', async () => {
    const port = fakePort();
    await expect(new SetOttStatus(port, lookup(false)).execute('ghost', true))
      .rejects.toBeInstanceOf(ClientNotFoundError);
    expect(port.setOtt).not.toHaveBeenCalled();
  });
});
