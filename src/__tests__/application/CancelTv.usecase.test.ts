/**
 * #47k / #72 — CancelTv: dar de baja TV por completo.
 *
 * Flujo: customer 404 → anti-coining guard (tvCancelledAt ya seteado → TvNotLinkedError) →
 * contract 404 → cuenta del cliente (use_internal_id); si no vinculada → TvNotLinkedError.
 * Por cada servicio de la cuenta: DELETE en Gigared (incluido el base — libera cupo) →
 * OTT disable (idempotente) → reconcile del ContractService TV con lista vacía (inactiva el ítem).
 * Si todo OK (failed.length === 0): renewCic (best-effort) + markCancelled (flag local).
 *
 * Shape de respuesta: { removed, failed, unremovable, ottDisabled, local, renew,
 * localCancelled, renewAttempted }. Todo OK → router 200; algún DELETE falló o local
 * falló → router 207. Re-run idempotente: los packs ya quitados no están en la cuenta.
 *
 * #72 cambios vs. #64:
 *   - `unlinked` eliminado (setInternalId(newCic,'') NUNCA funcionó → HTTP 400 siempre).
 *   - `localCancelled` reemplaza `unlinked`: true si el flag Client.tvCancelledAt fue seteado.
 *   - Anti-coining guard: si isCancelled → TvNotLinkedError antes de tocar el partner.
 *   - El renew SIGUE corriendo para reciclar el cupo del pack base (best-effort).
 */
import { CancelTv } from '@application/use-cases/gigared/CancelTv';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryClientTvCancellationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvCancellationRepository';
import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import { GigaredNotFoundError, GigaredUnavailableError, TvNotLinkedError } from '@domain/errors/gigared';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';

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

describe('CancelTv (#47k / #72)', () => {
  let cs: InMemoryContractServiceRepository;
  let catalog: InMemoryServiceCatalogRepository;
  beforeEach(() => {
    cs = new InMemoryContractServiceRepository();
    catalog = new InMemoryServiceCatalogRepository();
  });

  it('(a) happy: 2 packs → 2 DELETEs + ott disable + ítem local inactive + renewCic + localCancelled=true', async () => {
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
    const tvCancellation = new InMemoryClientTvCancellationRepository();

    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true), tvCancellation);
    const result = await uc.execute('cust-1', { contractId: 'C1' });

    expect(removeService).toHaveBeenCalledTimes(2);
    expect(removeService).toHaveBeenCalledWith('cust-1', '129');
    expect(removeService).toHaveBeenCalledWith('cust-1', '39');
    expect(setOtt).toHaveBeenCalledWith('cust-1', false);
    expect(result.removed.sort()).toEqual(['129', '39']);
    expect(result.failed).toEqual([]);
    expect(result.ottDisabled).toBe(true);
    expect(result.local).toBe('synced');
    // #64 — renew CIC (best-effort, para reciclar el cupo del pack base).
    expect(renewCic).toHaveBeenCalledWith('cust-1');
    expect(result.renew).toEqual({ oldCic: '0000000001', newCic: '0000000002' });
    // #72 — setInternalId(newCic,'') YA NO SE LLAMA — el partner siempre devuelve HTTP 400.
    expect(setInternalId).not.toHaveBeenCalledWith('0000000002', '');
    // #72 — localCancelled: el flag local fue seteado.
    expect(result.localCancelled).toBe(true);
    expect(await tvCancellation.isCancelled('cust-1')).toBe(true);
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

  it('(d) 2do DELETE falla → removed/failed correctos + OTT igual se intenta + local refleja + NO localCancelled', async () => {
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
    const tvCancellation = new InMemoryClientTvCancellationRepository();

    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true), tvCancellation);
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
    // #72 — failed > 0 → NO se marca el flag local
    expect(result.localCancelled).toBe(false);
    expect(await tvCancellation.isCancelled('cust-1')).toBe(false);
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

  // ----- #64: renew CIC (best-effort, para reciclar el cupo del pack base) -----

  it('(g) #64 renew falla → renew:null, no rompe; #72 localCancelled SIGUE seteándose (renew es best-effort)', async () => {
    await seedTvCatalog(catalog, cs);
    const renewCic = jest.fn(async () => { throw new Error('renew upstream 500'); });
    const port = fakePort({
      renewCic,
      getAccountByInternalId: jest.fn(async () => fakeAccount({ services: [] })),
    });
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true), tvCancellation);
    const result = await uc.execute('cust-1', { contractId: 'C1' });
    expect(result.renew).toBeNull();
    // #72: el flag local se setea aunque el renew falle — el teardown fue exitoso.
    expect(result.localCancelled).toBe(true);
    expect(await tvCancellation.isCancelled('cust-1')).toBe(true);
  });

  it('(h) #64 renew OK → result.renew presente; #72 setInternalId(newCic,"") NO se llama', async () => {
    await seedTvCatalog(catalog, cs);
    const renewCic = jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' }));
    const setInternalId = jest.fn(async () => {});
    // Account has a service → renewAttempted=true → renewCic is called.
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ renewCic, setInternalId, getAccountByInternalId });
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true), tvCancellation);
    const result = await uc.execute('cust-1', { contractId: 'C1' });
    expect(result.renewAttempted).toBe(true);
    expect(result.renew).toEqual({ oldCic: '0000000001', newCic: '0000000002' });
    // #72 — el setInternalId(newCic,'') muerto NO se llama
    expect(setInternalId).not.toHaveBeenCalledWith('0000000002', '');
    expect(result.localCancelled).toBe(true);
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
    // #72 — unlink ya no se llama (paso muerto eliminado)
    expect(calls).toEqual(['remove', 'ott', 'renew']);
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

  it('(k) #72 stateful — packs fallan → 207 SIN renew (cuenta sigue resoluble) → retry packs OK → renueva + localCancelled → 3er retry → anti-coining guard (TvNotLinkedError, SIN tocar el partner)', async () => {
    await seedTvCatalog(catalog, cs);

    // Stateful fake port: tracks current state. removeService falla mientras `failNext` esté
    // activo (simula el partner caído); el retry lo desactiva y los packs se quitan de verdad.
    const state = {
      services: [
        { id: '129', name: 'Gigared Play Full' },
        { id: '39', name: 'Pack Todo Futbol' },
      ] as { id: string; name: string }[],
      ott: { status: 'enabled' as 'enabled' | 'disabled' | null },
      failRemoves: true,
    };

    let renewCicCallCount = 0;

    const statefulPort: GigaredPort = {
      getSummary: jest.fn(),
      listAccounts: jest.fn(),
      getAccountByInternalId: jest.fn(async () => {
        return fakeAccount({ services: state.services, ott: { id: 'ott-1', stationaryLicenses: 2, mobileLicenses: 1, registeredDevices: 0, status: state.ott.status } });
      }),
      getAccountByCic: jest.fn(async () => fakeAccount()),
      register: jest.fn(), activate: jest.fn(),
      setInternalId: jest.fn(async () => {}),
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

    const tvCancellation = new InMemoryClientTvCancellationRepository();
    const uc = new CancelTv(statefulPort, cs, catalog, contractLookup(true), lookup(true), tvCancellation);

    // 1ª corrida: TODOS los removes fallan → failed.length > 0 → NI renew NI localCancelled.
    const result1 = await uc.execute('cust-1', { contractId: 'C1' });
    expect(result1.renewAttempted).toBe(true);
    expect(result1.failed).toHaveLength(2);
    // BLOQUEANTE: con packs fallidos, el renew NO corre → cuenta sigue resoluble por internal_id.
    expect(result1.renew).toBeNull();
    expect(result1.localCancelled).toBe(false);
    expect(renewCicCallCount).toBe(0);
    expect(await tvCancellation.isCancelled('cust-1')).toBe(false);
    // El router lo ve como 207 (failed.length > 0).
    expect(result1.failed.length > 0).toBe(true);

    // 2ª corrida (retry): el partner se recuperó → los packs se quitan de verdad → sin fallos →
    // recién ahora renueva y setea el flag local.
    state.failRemoves = false;
    const result2 = await uc.execute('cust-1', { contractId: 'C1' });
    expect(result2.failed).toEqual([]);
    expect(result2.removed.sort()).toEqual(['129', '39']);
    expect(result2.renew).toEqual({ oldCic: '0000000001', newCic: '0000000002' });
    expect(result2.localCancelled).toBe(true);
    expect(renewCicCallCount).toBe(1);
    expect(await tvCancellation.isCancelled('cust-1')).toBe(true);

    // 3ª corrida (retry sobre baja ya completa): #72 anti-coining guard → TvNotLinkedError
    // ANTES de llamar al partner (el flag local es la fuente de verdad).
    const getAccountByInternalIdSpy = statefulPort.getAccountByInternalId as jest.Mock;
    const callsBefore = getAccountByInternalIdSpy.mock.calls.length;

    await expect(uc.execute('cust-1', { contractId: 'C1' }))
      .rejects.toBeInstanceOf(TvNotLinkedError);
    // El partner NO fue consultado en el 3er intento (anti-coining guard corta antes).
    expect(getAccountByInternalIdSpy.mock.calls.length).toBe(callsBefore);
    // renewCic siguió en UNA sola llamada (no re-renueva).
    expect(renewCicCallCount).toBe(1);
  });

  it('(k2) #64 re-review: failed > 0 pero renewAttempted → NO renueva ni localCancelled (preserva el vínculo)', async () => {
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
    // Guard BLOQUEANTE: con failed>0, renew se saltea por completo.
    expect(renewCic).not.toHaveBeenCalled();
    expect(result.renew).toBeNull();
    expect(result.localCancelled).toBe(false);
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

  // ----- #67: el pack BASE es IRREMOVIBLE por política del CUA (no bloquea la baja) -----
  // Verificado LIVE 2026-06-12 (CIC 0006230159): DELETE del pack base 129 "Gigared Play Full"
  // → 424 external-service-error, detail "El servicio seleccionado no se puede dar de baja".
  // El adapter lo mapea a GigaredUnavailableError('Gigared external service (CUA) error', detail).
  // Decisión #67: ese error NO cuenta como `failed` bloqueante → va a `unremovable`, el flujo
  // sigue a renew+localCancelled y el modal lo reporta informativo.

  // detail EXACTO del CUA capturado live.
  const CUA_UNREMOVABLE_DETAIL = 'El servicio seleccionado no se puede dar de baja';
  const unremovableError = () =>
    new GigaredUnavailableError('Gigared external service (CUA) error', CUA_UNREMOVABLE_DETAIL);

  it('(n) #67 el caso real HONESTO: SOLO queda el pack base 129; su DELETE da el 424 "no se puede dar de baja". El reconcile RELEE la cuenta y el base SIGUE ahí (nunca se borró) → la fila TV igual se INACTIVA y limpia credenciales (excluye el irremovible) → renueva + localCancelled=true', async () => {
    const cat = await seedTvCatalog(catalog, cs);
    // Fila TV viva con credenciales y notes del CIC viejo: lo que el reconcile deshonesto dejaba intacto.
    const row = await cs.add({
      contractId: 'C1', serviceCatalogId: cat.id,
      notes: 'CIC 0006230159 · Gigared Play Full', tvLogin: 'GIGA129', tvPassword: 'old-secret',
    });
    const removeService = jest.fn(async () => { throw unremovableError(); });
    const renewCic = jest.fn(async () => ({ oldCic: '0006230159', newCic: '0006230160' }));
    const setInternalId = jest.fn(async () => {});
    // HONESTO: el base 129 NUNCA se borró (su DELETE lanzó 424). La relectura del reconcile
    // DEBE seguir viendo el base en la cuenta — esto es lo que el mock viejo ocultaba.
    const getAccountByInternalId = jest.fn(async () =>
      fakeAccount({ cic: '0006230159', services: [{ id: '129', name: 'Gigared Play Full' }] }),
    );
    const port = fakePort({ removeService, renewCic, setInternalId, getAccountByInternalId });
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true), tvCancellation);
    const result = await uc.execute('cust-1', { contractId: 'C1' });

    // el pack base NO está en removed ni en failed: está en unremovable (informativo).
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.unremovable).toHaveLength(1);
    expect(result.unremovable[0]!.id).toBe('129');
    expect(result.unremovable[0]!.detail).toContain('no se puede dar de baja');
    // failed.length === 0 → el guard #64 ya NO bloquea → renew corre.
    expect(result.renewAttempted).toBe(true);
    expect(renewCic).toHaveBeenCalledWith('cust-1');
    expect(result.renew).toEqual({ oldCic: '0006230159', newCic: '0006230160' });
    // #72 — setInternalId(newCic,'') NO se llama (paso muerto eliminado)
    expect(setInternalId).not.toHaveBeenCalledWith('0006230160', '');
    // #72 — localCancelled seteado
    expect(result.localCancelled).toBe(true);
    expect(await tvCancellation.isCancelled('cust-1')).toBe(true);
    // CRITICAL (#67 re-review): el reconcile EXCLUYE el id irremovible al decidir vacía/no-vacía.
    // Con sólo el base (excluido) la rama es "vacía" → la fila se INACTIVA y limpia credenciales,
    // NO queda activa con el CIC viejo. local='synced'.
    expect(result.local).toBe('synced');
    const after = await cs.getById(row.id);
    expect(after!.status).toBe('inactive');
    expect(after!.tvLogin).toBeNull();
    expect(after!.tvPassword).toBeNull();
  });

  it('(o) #67 mixto HONESTO: add-on se quita OK + pack base unremovable; el reconcile relee y el base SIGUE ahí → excluyendo el base la fila se INACTIVA → renueva + localCancelled=true', async () => {
    const cat = await seedTvCatalog(catalog, cs);
    const row = await cs.add({
      contractId: 'C1', serviceCatalogId: cat.id,
      notes: 'CIC 0000000001 · Gigared Play Full · Pack Todo Futbol',
      tvLogin: 'GIGA129', tvPassword: 'old-secret',
    });
    // 129 (base) tira el 424 unremovable; 39 (add-on) se quita bien.
    const removeService = jest.fn(async (_c: string, id: string) => {
      if (id === '129') throw unremovableError();
    });
    const renewCic = jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' }));
    // HONESTO: loop ve ambos; tras el run el add-on 39 está borrado pero el base 129 SIGUE
    // (su DELETE lanzó). El reconcile DEBE seguir viéndolo.
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [
        { id: '129', name: 'Gigared Play Full' },
        { id: '39', name: 'Pack Todo Futbol' },
      ] }))
      .mockResolvedValue(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }));
    const port = fakePort({ removeService, renewCic, getAccountByInternalId });
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true), tvCancellation);
    const result = await uc.execute('cust-1', { contractId: 'C1' });

    expect(result.removed).toEqual(['39']);
    expect(result.unremovable.map(u => u.id)).toEqual(['129']);
    expect(result.failed).toEqual([]);
    // sin failed bloqueante → renueva.
    expect(renewCic).toHaveBeenCalledTimes(1);
    expect(result.renew).not.toBeNull();
    // #72 — localCancelled seteado
    expect(result.localCancelled).toBe(true);
    expect(await tvCancellation.isCancelled('cust-1')).toBe(true);
    // CRITICAL: el reconcile excluye el base irremovible → fila inactivada + credenciales limpias.
    expect(result.local).toBe('synced');
    const after = await cs.getById(row.id);
    expect(after!.status).toBe('inactive');
    expect(after!.tvLogin).toBeNull();
    expect(after!.tvPassword).toBeNull();
  });

  it('(p) #67 un 424 REAL del CUA (otro detail, no "no se puede dar de baja") SIGUE siendo failed bloqueante → NO renueva ni localCancelled', async () => {
    await seedTvCatalog(catalog, cs);
    // Un GigaredUnavailableError con OTRO detail (CUA caído de verdad) NO es el caso del pack base.
    const removeService = jest.fn(async () => {
      throw new GigaredUnavailableError('Gigared external service (CUA) error', 'El CUA no respondió a tiempo');
    });
    const renewCic = jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' }));
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }))
      .mockResolvedValue(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }));
    const port = fakePort({ removeService, renewCic, getAccountByInternalId });
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });

    // este SÍ es failed bloqueante (no es la firma del pack base).
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe('129');
    expect(result.unremovable).toEqual([]);
    // failed > 0 → el guard #64 bloquea: NO renueva.
    expect(renewCic).not.toHaveBeenCalled();
    expect(result.renew).toBeNull();
    expect(result.localCancelled).toBe(false);
  });

  it('(q) #67 happy path normal (add-ons quitados OK) → unremovable=[] (shape siempre presente)', async () => {
    await seedTvCatalog(catalog, cs);
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '39', name: 'Pack Todo Futbol' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ getAccountByInternalId });
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });
    expect(result.removed).toEqual(['39']);
    expect(result.unremovable).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  // ----- #67 re-review MEDIUM: hardening de la cardinalidad. -----

  it('(r) #67 MEDIUM: DOS servicios matchean "no se puede dar de baja" → AMBIGUO → ambos a `failed`, unremovable=[] → NO renueva ni localCancelled (guard #64)', async () => {
    await seedTvCatalog(catalog, cs);
    // 129 y 39 dan AMBOS la firma unremovable. No sabemos cuál es el base → conservador.
    const removeService = jest.fn(async () => { throw unremovableError(); });
    const renewCic = jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' }));
    const setInternalId = jest.fn(async () => {});
    const getAccountByInternalId = jest.fn(async () =>
      fakeAccount({ services: [
        { id: '129', name: 'Gigared Play Full' },
        { id: '39', name: 'Add-on que el CUA también rechaza' },
      ] }),
    );
    const port = fakePort({ removeService, renewCic, setInternalId, getAccountByInternalId });
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });

    // AMBIGUO: cardinalidad 2 → todos a failed, ninguno a unremovable.
    expect(result.unremovable).toEqual([]);
    expect(result.failed.map(f => f.id).sort()).toEqual(['129', '39']);
    // failed > 0 → guard #64 bloquea renew: la cuenta sigue resoluble por internal_id.
    expect(renewCic).not.toHaveBeenCalled();
    expect(result.renew).toBeNull();
    expect(result.localCancelled).toBe(false);
  });

  it('(s) #67 MEDIUM: cuando matchea la firma unremovable, se emite un console.warn (señal de revisar)', async () => {
    await seedTvCatalog(catalog, cs);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const removeService = jest.fn(async () => { throw unremovableError(); });
      const renewCic = jest.fn(async () => ({ oldCic: '0006230159', newCic: '0006230160' }));
      const getAccountByInternalId = jest.fn(async () =>
        fakeAccount({ cic: '0006230159', services: [{ id: '129', name: 'Gigared Play Full' }] }),
      );
      const port = fakePort({ removeService, renewCic, getAccountByInternalId });
      const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
      await uc.execute('cust-1', { contractId: 'C1' });

      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]![0])).toContain('[gigared] unremovable inesperado');
    } finally {
      warn.mockRestore();
    }
  });

  // ----- #72: anti-coining guard + localCancelled -----

  it('(t) #72 anti-coining: tvCancellation pre-seeded cancelled → TvNotLinkedError SIN llamar al partner', async () => {
    await seedTvCatalog(catalog, cs);
    const port = fakePort();
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1');

    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true), tvCancellation);
    await expect(uc.execute('cust-1', { contractId: 'C1' }))
      .rejects.toBeInstanceOf(TvNotLinkedError);

    // El partner NO fue tocado: ni getAccountByInternalId ni removeService ni renewCic.
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
    expect(port.removeService).not.toHaveBeenCalled();
    expect(port.renewCic).not.toHaveBeenCalled();
  });

  it('(u) #72 renew falla → localCancelled SIGUE siendo true (renew es best-effort, el teardown fue exitoso)', async () => {
    await seedTvCatalog(catalog, cs);
    const renewCic = jest.fn(async () => { throw new Error('renew partner down'); });
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '39', name: 'Pack Todo Futbol' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ renewCic, getAccountByInternalId });
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true), tvCancellation);
    const result = await uc.execute('cust-1', { contractId: 'C1' });

    expect(result.renew).toBeNull();          // renew falló (best-effort)
    expect(result.localCancelled).toBe(true); // pero el flag local SÍ se seteó
    expect(await tvCancellation.isCancelled('cust-1')).toBe(true);
  });

  it('(v) #72 failed > 0 → markCancelled NO se llama, localCancelled false', async () => {
    await seedTvCatalog(catalog, cs);
    const removeService = jest.fn(async () => { throw new Error('partner 500'); });
    const getAccountByInternalId = jest.fn()
      .mockResolvedValue(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }));
    const port = fakePort({ removeService, getAccountByInternalId });
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true), tvCancellation);
    const result = await uc.execute('cust-1', { contractId: 'C1' });

    expect(result.failed).toHaveLength(1);
    expect(result.localCancelled).toBe(false);
    expect(await tvCancellation.isCancelled('cust-1')).toBe(false);
  });

  it('(w) #72 sin tvCancellation (dep omitida) → use case funciona sin flag (localCancelled=false)', async () => {
    await seedTvCatalog(catalog, cs);
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '39', name: 'Pack' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ getAccountByInternalId });
    // No tvCancellation dep → use case sin flag (backward-compat)
    const uc = new CancelTv(port, cs, catalog, contractLookup(true), lookup(true));
    const result = await uc.execute('cust-1', { contractId: 'C1' });
    expect(result.removed).toEqual(['39']);
    expect(result.localCancelled).toBe(false); // sin dep → no puede marcar
  });
});
