/**
 * #47k — CancelTv: dar de baja TV por completo.
 *
 * Flujo: customer 404 → contract 404 → cuenta del cliente (use_internal_id);
 * si no vinculada → TvNotLinkedError. Por cada servicio de la cuenta: DELETE en
 * Gigared (incluido el base — libera cupo) → OTT disable (idempotente) → reconcile
 * del ContractService TV con lista vacía (inactiva el ítem).
 *
 * Shape de respuesta: { removed: string[], failed: {id, detail}[], ottDisabled: bool,
 * local: 'synced' | 'failed' }. Todo OK → router 200; algún DELETE falló o local
 * falló → router 207. Re-run idempotente: los packs ya quitados no están en la cuenta.
 */
import { CancelTv } from '@application/use-cases/gigared/CancelTv';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import { GigaredNotFoundError, TvNotLinkedError } from '@domain/errors/gigared';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  return {
    cic: '0000000001', gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '19/01/2026', services: [], internalId: 'cust-1', ott: null, ...over,
  };
}

function fakePort(over: Partial<GigaredPort> = {}): GigaredPort {
  return {
    getSummary: jest.fn(),
    listAccounts: jest.fn(),
    getAccountByInternalId: jest.fn(async () => fakeAccount()),
    getAccountByCic: jest.fn(async () => fakeAccount()),
    register: jest.fn(), activate: jest.fn(), setInternalId: jest.fn(async () => {}),
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
// existing tests (which act on 'cust-1') keep passing; pass a different owner to simulate
// a contract that belongs to ANOTHER customer (the #47k HIGH).
const contractLookup = (exists: boolean, ownerId = 'cust-1') => ({
  findById: async (id: string) => (exists ? { id, clientId: ownerId } : null),
});

async function seedTvCatalog(catalog: InMemoryServiceCatalogRepository, cs: InMemoryContractServiceRepository, active = true) {
  const cat = await catalog.create({ name: 'TV', label: 'TV', active, sortOrder: 0 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (cs as any).catalog[cat.id] = { name: cat.name, label: cat.label };
  return cat;
}

describe('CancelTv (#47k)', () => {
  let cs: InMemoryContractServiceRepository;
  let catalog: InMemoryServiceCatalogRepository;
  beforeEach(() => {
    cs = new InMemoryContractServiceRepository();
    catalog = new InMemoryServiceCatalogRepository();
  });

  it('(a) happy: 2 packs → 2 DELETEs + ott disable + ítem local inactive → shape completo', async () => {
    const cat = await seedTvCatalog(catalog, cs);
    const row = await cs.add({ contractId: 'C1', serviceCatalogId: cat.id, notes: 'CIC 0000000001 · Gigared Play Full' });
    const removeService = jest.fn(async () => {});
    const setOtt = jest.fn(async () => {});
    const renewCic = jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' }));
    const setInternalId = jest.fn(async () => {});
    // 1ª llamada (loop): la cuenta tiene los 2 packs; 2ª (reconcile): ya vacía.
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [
        { id: '129', name: 'Gigared Play Full' },
        { id: '39', name: 'Pack Todo Futbol' },
      ] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ removeService, setOtt, renewCic, setInternalId, getAccountByInternalId });

    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });

    expect(removeService).toHaveBeenCalledTimes(2);
    expect(removeService).toHaveBeenCalledWith('cust-1', '129');
    expect(removeService).toHaveBeenCalledWith('cust-1', '39');
    expect(setOtt).toHaveBeenCalledWith('cust-1', false);
    expect(result.removed.sort()).toEqual(['129', '39']);
    expect(result.failed).toEqual([]);
    expect(result.ottDisabled).toBe(true);
    expect(result.local).toBe('synced');
    // #64 — renew CIC (genera nuevo CIC) y desvincula el internal_id del NUEVO CIC →
    // el cliente queda "como si no tuviera TV" (getAccountByInternalId 404 después).
    expect(renewCic).toHaveBeenCalledWith('cust-1');
    expect(result.renew).toEqual({ oldCic: '0000000001', newCic: '0000000002' });
    // unlink: setInternalId(newCic, '') limpia el vínculo en el partner.
    expect(setInternalId).toHaveBeenCalledWith('0000000002', '');
    expect(result.unlinked).toBe(true);
    // ítem local inactivado (no borrado)
    const after = await cs.getById(row.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('inactive');
  });

  it('(a2) #65 M6 — al inactivar la fila TV, LIMPIA tvLogin/tvPassword (baja = como si no tuviera)', async () => {
    const cat = await seedTvCatalog(catalog, cs);
    const row = await cs.add({
      contractId: 'C1', serviceCatalogId: cat.id,
      notes: 'CIC 0000000001 · Gigared Play Full', tvLogin: 'GIGA100', tvPassword: 'secret99',
    });
    // loop ve 1 pack; reconcile relee la cuenta vacía → inactiva la fila.
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ getAccountByInternalId });
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    await uc.execute('cust-1', { contractId: 'C1' });

    const after = await cs.getById(row.id);
    expect(after!.status).toBe('inactive');
    // M6 — las credenciales zombie quedan limpias.
    expect(after!.tvLogin).toBeNull();
    expect(after!.tvPassword).toBeNull();
  });

  it('(b) cuenta sin vincular → TvNotLinkedError (router → 404 TV_NOT_LINKED)', async () => {
    await seedTvCatalog(catalog, cs);
    const port = fakePort({
      getAccountByInternalId: jest.fn(async () => { throw new GigaredNotFoundError(); }),
    });
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    await expect(uc.execute('cust-1', { contractId: 'C1' }))
      .rejects.toBeInstanceOf(TvNotLinkedError);
    expect(port.removeService).not.toHaveBeenCalled();
  });

  it('(c) contractId inválido → ContractNotFoundError SIN tocar Gigared', async () => {
    await seedTvCatalog(catalog, cs);
    const port = fakePort();
    const uc = new CancelTv(port, cs, catalog, contractLookup(false), lookup(true));
    await expect(uc.execute('cust-1', { contractId: 'ghost' }))
      .rejects.toBeInstanceOf(ContractNotFoundError);
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
    expect(port.removeService).not.toHaveBeenCalled();
  });

  it('(c2) #47k HIGH: contractId de OTRO cliente → ContractNotFoundError SIN tocar Gigared', async () => {
    await seedTvCatalog(catalog, cs);
    const port = fakePort();
    // El contrato existe pero pertenece a 'cust-B' — el guard NO debe dejarlo pasar.
    const uc = new CancelTv(port, cs, catalog, contractLookup(true, 'cust-B'), lookup(true));
    await expect(uc.execute('cust-1', { contractId: 'C-of-B' }))
      .rejects.toBeInstanceOf(ContractNotFoundError);
    // CERO llamadas a Gigared: no se lee la cuenta ni se borra ningún servicio.
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
    expect(port.removeService).not.toHaveBeenCalled();
    expect(port.setOtt).not.toHaveBeenCalled();
  });

  it('customer inexistente → ClientNotFoundError', async () => {
    await seedTvCatalog(catalog, cs);
    const uc = new CancelTv(fakePort(), cs, catalog, contractLookup(true), lookup(false));
    await expect(uc.execute('ghost', { contractId: 'C1' }))
      .rejects.toBeInstanceOf(ClientNotFoundError);
  });

  it('(d) 2do DELETE falla → removed/failed correctos + OTT igual se intenta + local refleja', async () => {
    const cat = await seedTvCatalog(catalog, cs);
    await cs.add({ contractId: 'C1', serviceCatalogId: cat.id, notes: 'CIC 0000000001 · Gigared Play Full' });
    const setOtt = jest.fn(async () => {});
    const removeService = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('upstream 500'));
    // loop ve los 2 packs; reconcile ve que sólo queda el que falló (39).
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [
        { id: '129', name: 'Gigared Play Full' },
        { id: '39', name: 'Pack Todo Futbol' },
      ] }))
      .mockResolvedValue(fakeAccount({ services: [{ id: '39', name: 'Pack Todo Futbol' }] }));
    const port = fakePort({ removeService, setOtt, getAccountByInternalId });

    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });

    expect(result.removed).toEqual(['129']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe('39');
    expect(result.failed[0]!.detail).toContain('upstream 500');
    // OTT se intenta igual aunque hubo fallo parcial
    expect(setOtt).toHaveBeenCalledWith('cust-1', false);
    expect(result.ottDisabled).toBe(true);
    // sigue habiendo un pack en la cuenta → reconcile NO inactiva → local refleja sincronía
    expect(result.local).toBe('synced');
  });

  it('(e) re-run tras (d) con el pack restante → solo 1 DELETE (idempotencia)', async () => {
    const cat = await seedTvCatalog(catalog, cs);
    await cs.add({ contractId: 'C1', serviceCatalogId: cat.id, notes: 'CIC 0000000001 · Pack Todo Futbol' });
    const removeService = jest.fn(async () => {});
    // sólo queda el pack que había fallado; reconcile lo ve vacío después.
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '39', name: 'Pack Todo Futbol' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ removeService, getAccountByInternalId });

    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });

    expect(removeService).toHaveBeenCalledTimes(1);
    expect(removeService).toHaveBeenCalledWith('cust-1', '39');
    expect(result.removed).toEqual(['39']);
    expect(result.failed).toEqual([]);
    expect(result.local).toBe('synced');
  });

  it('(f) cuenta vinculada SIN servicios → solo OTT disable + reconcile (removed=[])', async () => {
    await seedTvCatalog(catalog, cs);
    const removeService = jest.fn(async () => {});
    const setOtt = jest.fn(async () => {});
    const port = fakePort({
      removeService, setOtt,
      getAccountByInternalId: jest.fn(async () => fakeAccount({ services: [] })),
    });
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });

    expect(removeService).not.toHaveBeenCalled();
    expect(setOtt).toHaveBeenCalledWith('cust-1', false);
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.ottDisabled).toBe(true);
    expect(result.local).toBe('synced');
  });

  it('reconcile falla (csRepo throws) → local: "failed"', async () => {
    const cat = await seedTvCatalog(catalog, cs);
    await cs.add({ contractId: 'C1', serviceCatalogId: cat.id, notes: 'CIC 0000000001 · Gigared Play Full' });
    jest.spyOn(cs, 'update').mockRejectedValue(new Error('db down'));
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ getAccountByInternalId });
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });
    expect(result.removed).toEqual(['129']);
    expect(result.local).toBe('failed');
  });

  it('OTT disable falla (no es "ya deshabilitada") → ottDisabled: false, no rompe', async () => {
    await seedTvCatalog(catalog, cs);
    const setOtt = jest.fn(async () => { throw new Error('ott upstream down'); });
    const port = fakePort({
      setOtt,
      getAccountByInternalId: jest.fn(async () => fakeAccount({ services: [] })),
    });
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });
    expect(result.ottDisabled).toBe(false);
  });

  // ----- #64: renew CIC + desvinculación -----

  it('(g) #64 renew falla → renew:null, unlinked:false, NO se intenta unlink, no rompe', async () => {
    await seedTvCatalog(catalog, cs);
    const renewCic = jest.fn(async () => { throw new Error('renew upstream 500'); });
    const setInternalId = jest.fn(async () => {});
    const port = fakePort({
      renewCic, setInternalId,
      getAccountByInternalId: jest.fn(async () => fakeAccount({ services: [] })),
    });
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });
    expect(result.renew).toBeNull();
    expect(result.unlinked).toBe(false);
    // sin renew no hay newCic → no se intenta el unlink (no sabemos qué CIC limpiar).
    expect(setInternalId).not.toHaveBeenCalled();
  });

  it('(h) #64 renew OK pero unlink falla → renew presente, unlinked:false, no rompe', async () => {
    await seedTvCatalog(catalog, cs);
    const renewCic = jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' }));
    const setInternalId = jest.fn(async () => { throw new Error('partner rejected empty internal_id'); });
    // Account has a service → renewAttempted=true → renewCic is called.
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ renewCic, setInternalId, getAccountByInternalId });
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });
    expect(result.renewAttempted).toBe(true);
    expect(result.renew).toEqual({ oldCic: '0000000001', newCic: '0000000002' });
    expect(setInternalId).toHaveBeenCalledWith('0000000002', '');
    expect(result.unlinked).toBe(false);
  });

  it('(i) #64 orden: renew se ejecuta DESPUÉS de quitar packs y OTT off', async () => {
    await seedTvCatalog(catalog, cs);
    const calls: string[] = [];
    const removeService = jest.fn(async () => { calls.push('remove'); });
    const setOtt = jest.fn(async () => { calls.push('ott'); });
    const renewCic = jest.fn(async () => { calls.push('renew'); return { oldCic: '0000000001', newCic: '0000000002' }; });
    const setInternalId = jest.fn(async () => { calls.push('unlink'); });
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ removeService, setOtt, renewCic, setInternalId, getAccountByInternalId });
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    await uc.execute('cust-1', { contractId: 'C1' });
    expect(calls).toEqual(['remove', 'ott', 'renew', 'unlink']);
  });

  // ----- #64 fix wave: H1 guard anti re-renew -----

  it('(j) #64 H1: renewAttempted true en happy path (packs>0) → renewCic llamado, result.renewAttempted=true', async () => {
    await seedTvCatalog(catalog, cs);
    const renewCic = jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' }));
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ renewCic, getAccountByInternalId });
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });
    expect(result.renewAttempted).toBe(true);
    expect(renewCic).toHaveBeenCalledTimes(1);
  });

  it('(k) #64 re-review: stateful — packs fallan → 207 SIN renew (cuenta sigue vinculada) → retry packs OK → renueva → unlink → 404', async () => {
    await seedTvCatalog(catalog, cs);

    // Stateful fake port: tracks current state. removeService falla mientras `failNext` esté
    // activo (simula el partner caído); el retry lo desactiva y los packs se quitan de verdad.
    const state = {
      services: [
        { id: '129', name: 'Gigared Play Full' },
        { id: '39', name: 'Pack Todo Futbol' },
      ] as { id: string; name: string }[],
      ott: { status: 'enabled' as 'enabled' | 'disabled' | null },
      internalId: 'cust-1' as string,
      unlinked: false,
      failRemoves: true,
    };

    let renewCicCallCount = 0;

    const statefulPort: GigaredPort = {
      getSummary: jest.fn(),
      listAccounts: jest.fn(),
      getAccountByInternalId: jest.fn(async () => {
        // Tras el unlink (state.unlinked), la cuenta desaparece por internal_id (404).
        if (state.unlinked) throw new GigaredNotFoundError();
        return fakeAccount({ services: state.services, ott: { id: 'ott-1', stationaryLicenses: 2, mobileLicenses: 1, registeredDevices: 0, status: state.ott.status } });
      }),
      getAccountByCic: jest.fn(async () => fakeAccount()),
      register: jest.fn(), activate: jest.fn(),
      setInternalId: jest.fn(async (_cic: string, internalId: string) => {
        // Limpiar internal_id = la cuenta queda desvinculada.
        if (internalId === '') state.unlinked = true;
      }),
      addService: jest.fn(async () => {}),
      removeService: jest.fn(async (_customerId: string, serviceId: string) => {
        if (state.failRemoves) throw new Error('partner 500');
        state.services = state.services.filter(s => s.id !== serviceId);
      }),
      setOtt: jest.fn(async (_customerId: string, enabled: boolean) => {
        state.ott.status = enabled ? 'enabled' : 'disabled';
      }),
      changePassword: jest.fn(async () => {}),
      renewCic: jest.fn(async () => {
        renewCicCallCount++;
        return { oldCic: '0000000001', newCic: '0000000002' };
      }),
    };

    const uc = new CancelTv(statefulPort, cs, catalog, contractLookup(true), lookup(true));

    // 1ª corrida: TODOS los removes fallan → failed.length > 0 → NI renew NI unlink.
    const result1 = await uc.execute('cust-1', { contractId: 'C1' });
    expect(result1.renewAttempted).toBe(true);
    expect(result1.failed).toHaveLength(2);
    // BLOQUEANTE: con packs fallidos, el renew NO corre → cuenta sigue resoluble por internal_id.
    expect(result1.renew).toBeNull();
    expect(result1.unlinked).toBe(false);
    expect(renewCicCallCount).toBe(0);
    expect(state.unlinked).toBe(false);
    // El router lo ve como 207 (failed.length > 0).
    expect(result1.failed.length > 0).toBe(true);

    // La cuenta SIGUE vinculada: un getAccountByInternalId no lanza 404 (el retry funciona).
    await expect(statefulPort.getAccountByInternalId('cust-1')).resolves.toBeDefined();

    // 2ª corrida (retry): el partner se recuperó → los packs se quitan de verdad → sin fallos →
    // recién ahora renueva y desvincula.
    state.failRemoves = false;
    const result2 = await uc.execute('cust-1', { contractId: 'C1' });
    expect(result2.failed).toEqual([]);
    expect(result2.removed.sort()).toEqual(['129', '39']);
    expect(result2.renew).toEqual({ oldCic: '0000000001', newCic: '0000000002' });
    expect(result2.unlinked).toBe(true);
    expect(renewCicCallCount).toBe(1);
    expect(state.unlinked).toBe(true);

    // 3ª corrida (retry sobre baja ya completa): la cuenta desapareció → TvNotLinkedError (404).
    await expect(uc.execute('cust-1', { contractId: 'C1' }))
      .rejects.toBeInstanceOf(TvNotLinkedError);
    // renewCic siguió en UNA sola llamada (no re-renueva).
    expect(renewCicCallCount).toBe(1);
  });

  it('(k2) #64 re-review: failed > 0 pero renewAttempted → NO renueva ni desvincula (preserva el vínculo)', async () => {
    await seedTvCatalog(catalog, cs);
    const renewCic = jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' }));
    const setInternalId = jest.fn(async () => {});
    // Un único pack que falla al removerse → failed.length === 1.
    const removeService = jest.fn(async () => { throw new Error('partner 500'); });
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }))
      .mockResolvedValue(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }));
    const port = fakePort({ renewCic, setInternalId, removeService, getAccountByInternalId });
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });

    expect(result.renewAttempted).toBe(true);
    expect(result.failed).toHaveLength(1);
    // Guard BLOQUEANTE: con failed>0, renew y unlink se saltan por completo.
    expect(renewCic).not.toHaveBeenCalled();
    expect(setInternalId).not.toHaveBeenCalled();
    expect(result.renew).toBeNull();
    expect(result.unlinked).toBe(false);
  });

  it('(l) #64 H1: cuenta ya pelada (services:[], ott disabled) pero aún existe → renewAttempted false, renewCic NO llamado', async () => {
    await seedTvCatalog(catalog, cs);
    const renewCic = jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' }));
    const port = fakePort({
      renewCic,
      getAccountByInternalId: jest.fn(async () => fakeAccount({
        services: [],
        ott: { id: 'ott-1', stationaryLicenses: 2, mobileLicenses: 1, registeredDevices: 0, status: 'disabled' },
      })),
    });
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });
    expect(result.renewAttempted).toBe(false);
    expect(renewCic).not.toHaveBeenCalled();
    expect(result.renew).toBeNull();
    expect(result.unlinked).toBe(false);
  });

  it('(m) #64 H1: services vacío pero OTT enabled → renewAttempted true (ott teardown cuenta)', async () => {
    await seedTvCatalog(catalog, cs);
    const renewCic = jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' }));
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({
        services: [],
        ott: { id: 'ott-1', stationaryLicenses: 2, mobileLicenses: 1, registeredDevices: 0, status: 'enabled' },
      }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ renewCic, getAccountByInternalId });
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });
    expect(result.renewAttempted).toBe(true);
    expect(renewCic).toHaveBeenCalledTimes(1);
  });
});
