/**
 * service-transfer Wave 1 — TransferTvToCustomer unit tests (fakes + in-memory, NUNCA Prisma).
 *
 * Hechos F0 (2026-07-10) que gobiernan el diseño y estos tests:
 *  - El CUA NO pisa el internal_id: setInternalId(cic, nuevoId) devuelve 200 pero AGREGA UN ALIAS
 *    (ambos ids resuelven; el payload muestra el PRIMER internal_id para siempre). Por eso el use
 *    case VERIFICA re-leyendo por el internal_id destino y chequeando account.cic === cic.
 *  - El severing del origen es LOCAL (tvCancellation.markCancelled). JAMÁS CancelTv/removeService/
 *    setOtt/renewCic sobre la cuenta (TV-2): mataría la cuenta que ahora usa el destino.
 */
import { TransferTvToCustomer } from '@application/use-cases/gigared/TransferTvToCustomer';
import type { GigaredPort, GigaredAccount, GigaredService } from '@domain/ports/GigaredPort';
import {
  GigaredNotFoundError,
  GigaredRejectedError,
  TvAlreadyLinkedError,
  TvNotLinkedError,
} from '@domain/errors/gigared';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryClientTvCancellationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvCancellationRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import type { TvActivationEventRepository } from '@domain/ports/TvActivationEventRepository';

const CIC = '0000000001';

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  const base: GigaredAccount = {
    cic: CIC, gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '2026-01-19', services: [{ id: '129', name: 'Gigared Play Full' }],
    internalId: 'cust-A', clientId: 'cust-A', ott: null,
  };
  return { ...base, ...over };
}

/**
 * Fake STATEFUL del partner para el seam del transfer:
 *  - la cuenta origen resuelve por `sourceId` (salvo sourceMissing).
 *  - el destino `targetId` da 404 hasta que setInternalId corre; después resuelve
 *    con el MISMO payload de la cuenta (F0: internalId sigue mostrando el PRIMER id).
 *  - aliasTakes:false simula el "200 sin efecto" (GET post-PATCH sigue 404).
 *  - aliasCic simula un alias que resuelve a OTRO CIC (cuenta equivocada).
 *  - targetPreLinkedCic: el destino YA resuelve a una cuenta antes del PATCH.
 */
function transferPort(opts: {
  sourceId?: string;
  targetId?: string;
  services?: GigaredService[];
  aliasTakes?: boolean;
  aliasCic?: string;
  targetPreLinkedCic?: string;
  sourceMissing?: boolean;
} = {}): GigaredPort {
  const sourceId = opts.sourceId ?? 'cust-A';
  const targetId = opts.targetId ?? 'cust-B';
  const services = opts.services ?? [{ id: '129', name: 'Gigared Play Full' }];
  const account = fakeAccount({ cic: CIC, internalId: sourceId, clientId: sourceId, services });
  let aliased = false;
  return {
    getSummary: jest.fn(async () => ({ accounts: { registered: 1, unregistered: 0, total: 1 }, services: [] })),
    listAccounts: jest.fn(async () => [account]),
    getAccountByInternalId: jest.fn(async (id: string) => {
      if (id === sourceId && !opts.sourceMissing) return account;
      if (id === targetId) {
        if (opts.targetPreLinkedCic) return fakeAccount({ cic: opts.targetPreLinkedCic, internalId: targetId, clientId: targetId });
        if (aliased && (opts.aliasTakes ?? true)) {
          // F0: el payload muestra el PRIMER internal_id para siempre — sólo cambia por qué id resolvió.
          return { ...account, cic: opts.aliasCic ?? account.cic };
        }
      }
      throw new GigaredNotFoundError();
    }),
    getAccountByCic: jest.fn(async () => account),
    register: jest.fn(async () => {}),
    activate: jest.fn(async () => {}),
    setInternalId: jest.fn(async () => { aliased = true; }),
    addService: jest.fn(async () => {}),
    removeService: jest.fn(async () => {}),
    setOtt: jest.fn(async () => {}),
    changePassword: jest.fn(async () => {}),
    renewCic: jest.fn(async () => ({ oldCic: CIC, newCic: '0000000002' })),
  };
}

const customers = (map: Record<string, { name?: string; tvActivationSeq?: number }>) => ({
  findById: async (id: string) => (id in map ? { id, ...map[id]! } : null),
});
const contracts = (map: Record<string, string>) => ({
  findById: async (id: string) => (id in map ? { id, clientId: map[id]! } : null),
});

const DEFAULT_CUSTOMERS = {
  'cust-A': { name: 'Martino Agustina' },
  'cust-B': { name: 'Martino Marcelo Julián' },
};
const DEFAULT_CONTRACTS = { 'C-A': 'cust-A', 'C-B': 'cust-B' };

/** service-transfer (TV-3) — fake `TvActivationEventRepository` seam, spies on record(). */
function fakeActivationEventRepo(): TvActivationEventRepository {
  return {
    record: jest.fn(async (input) => ({
      id: 'evt', customerName: null, seq: null, cic: null, internalId: null, contractId: null, reason: null,
      ...input,
      createdAt: new Date().toISOString(),
    })),
    listByClient: jest.fn(async () => []),
    list: jest.fn(async () => []),
    listByContract: jest.fn(async () => []),
  };
}

interface Ctx {
  port: GigaredPort;
  cs: InMemoryContractServiceRepository;
  catalog: InMemoryServiceCatalogRepository;
  tvCancellation: InMemoryClientTvCancellationRepository;
  events: InMemoryContractServiceEventRepository;
  activationEventRepo: TvActivationEventRepository;
  tvCatalogId: string;
  uc: TransferTvToCustomer;
}

async function buildCtx(opts: {
  port?: GigaredPort;
  customers?: Record<string, { name?: string; tvActivationSeq?: number }>;
  contracts?: Record<string, string>;
  seedSourceRow?: boolean;
  withEvents?: boolean;
  withActivationEventRepo?: boolean;
} = {}): Promise<Ctx> {
  const port = opts.port ?? transferPort();
  const cs = new InMemoryContractServiceRepository();
  const catalog = new InMemoryServiceCatalogRepository();
  const cat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (cs as any).catalog[cat.id] = { name: cat.name, label: cat.label };
  if (opts.seedSourceRow ?? true) {
    // Slot TV managed del ORIGEN, con credenciales vivas (lo que la transferencia debe inactivar+limpiar).
    const row = await cs.add({
      contractId: 'C-A', serviceCatalogId: cat.id,
      notes: `CIC ${CIC} · Gigared Play Full`, tvLogin: 'GIGA100', tvPassword: 'ip243200',
    });
    void row;
  }
  const tvCancellation = new InMemoryClientTvCancellationRepository();
  const events = new InMemoryContractServiceEventRepository();
  const activationEventRepo = fakeActivationEventRepo();
  const uc = new TransferTvToCustomer(
    port,
    customers(opts.customers ?? DEFAULT_CUSTOMERS),
    contracts(opts.contracts ?? DEFAULT_CONTRACTS),
    cs,
    catalog,
    tvCancellation,
    (opts.withEvents ?? true) ? events : undefined,
    (opts.withActivationEventRepo ?? true) ? activationEventRepo : undefined,
  );
  return { port, cs, catalog, tvCancellation, events, activationEventRepo, tvCatalogId: cat.id, uc };
}

let warnSpy: jest.SpyInstance;
beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warnSpy.mockRestore(); });

describe('TransferTvToCustomer — guard order (pinned)', () => {
  it('source customer inexistente → ClientNotFoundError, Gigared NUNCA llamado', async () => {
    const ctx = await buildCtx({ customers: { 'cust-B': { name: 'M' } } });
    await expect(ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' }))
      .rejects.toBeInstanceOf(ClientNotFoundError);
    expect(ctx.port.getAccountByInternalId).not.toHaveBeenCalled();
    expect(ctx.port.setInternalId).not.toHaveBeenCalled();
  });

  it('target customer inexistente → ClientNotFoundError, Gigared NUNCA llamado', async () => {
    const ctx = await buildCtx({ customers: { 'cust-A': { name: 'A' } } });
    await expect(ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' }))
      .rejects.toBeInstanceOf(ClientNotFoundError);
    expect(ctx.port.getAccountByInternalId).not.toHaveBeenCalled();
  });

  it('contrato destino AJENO (pertenece a otro cliente) → ContractNotFoundError ANTES de tocar Gigared', async () => {
    // C-A pertenece a cust-A, no al destino cust-B → 404 sin leak, CERO llamadas al port.
    const ctx = await buildCtx();
    await expect(ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-A' }))
      .rejects.toBeInstanceOf(ContractNotFoundError);
    expect(ctx.port.getAccountByInternalId).not.toHaveBeenCalled();
    expect(ctx.port.setInternalId).not.toHaveBeenCalled();
  });

  it('contrato destino inexistente → ContractNotFoundError ANTES de tocar Gigared', async () => {
    const ctx = await buildCtx();
    await expect(ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'ghost' }))
      .rejects.toBeInstanceOf(ContractNotFoundError);
    expect(ctx.port.getAccountByInternalId).not.toHaveBeenCalled();
  });

  it('origen cancelado localmente (tvCancelledAt, SIN alias previo al destino) → TvNotLinkedError sin setInternalId', async () => {
    // Fix wave HIGH-1: el guard order nuevo resuelve AMBOS lados en el partner ANTES de decidir
    // resume-vs-bloqueo, así que el GET al partner SÍ corre; lo que jamás corre es el PATCH.
    const ctx = await buildCtx();
    ctx.tvCancellation.seedCancelled('cust-A');
    await expect(ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' }))
      .rejects.toBeInstanceOf(TvNotLinkedError);
    expect(ctx.port.setInternalId).not.toHaveBeenCalled();
    // Cero efectos locales: la fila origen quedó intacta y no hay eventos.
    expect((await ctx.cs.getByPair('C-A', ctx.tvCatalogId))!.status).toBe('active');
    expect(ctx.events.all()).toHaveLength(0);
  });

  it('origen sin cuenta upstream (404) → TvNotLinkedError, setInternalId NUNCA llamado', async () => {
    const ctx = await buildCtx({ port: transferPort({ sourceMissing: true }) });
    await expect(ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' }))
      .rejects.toBeInstanceOf(TvNotLinkedError);
    expect(ctx.port.setInternalId).not.toHaveBeenCalled();
  });

  it('destino YA vinculado (su internal_id resuelve) → TvAlreadyLinkedError sin setInternalId', async () => {
    const ctx = await buildCtx({ port: transferPort({ targetPreLinkedCic: '0000009999' }) });
    await expect(ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' }))
      .rejects.toBeInstanceOf(TvAlreadyLinkedError);
    expect(ctx.port.setInternalId).not.toHaveBeenCalled();
    // Cero efectos locales.
    expect(await ctx.tvCancellation.isCancelled('cust-A')).toBe(false);
    expect(ctx.events.all()).toHaveLength(0);
  });
});

describe('TransferTvToCustomer — happy path', () => {
  it('orden pinned alias→verify→severing→slots→eventos, resultado y estado local completos', async () => {
    const ctx = await buildCtx();
    const calls: string[] = [];
    // Instrumentar el orden de las operaciones clave.
    const origGet = ctx.port.getAccountByInternalId as jest.Mock;
    const origGetImpl = origGet.getMockImplementation()!;
    origGet.mockImplementation(async (id: string) => { calls.push(`get:${id}`); return origGetImpl(id); });
    const origSet = ctx.port.setInternalId as jest.Mock;
    const origSetImpl = origSet.getMockImplementation()!;
    origSet.mockImplementation(async (cic: string, id: string) => { calls.push('set:alias'); return origSetImpl(cic, id); });
    const origMark = ctx.tvCancellation.markCancelled.bind(ctx.tvCancellation);
    jest.spyOn(ctx.tvCancellation, 'markCancelled').mockImplementation(async (id) => { calls.push('markCancelled'); return origMark(id); });
    const origClear = ctx.tvCancellation.clearCancelled.bind(ctx.tvCancellation);
    jest.spyOn(ctx.tvCancellation, 'clearCancelled').mockImplementation(async (id) => { calls.push('clearCancelled'); return origClear(id); });
    const origUpdate = ctx.cs.update.bind(ctx.cs);
    jest.spyOn(ctx.cs, 'update').mockImplementation(async (id, data) => { calls.push('cs.update'); return origUpdate(id, data); });
    const origAdd = ctx.cs.add.bind(ctx.cs);
    jest.spyOn(ctx.cs, 'add').mockImplementation(async (data) => { calls.push('cs.add'); return origAdd(data); });
    const origRecord = ctx.events.record.bind(ctx.events);
    jest.spyOn(ctx.events, 'record').mockImplementation(async (input) => { calls.push(`event:${input.changeKind}`); return origRecord(input); });

    // El destino venía de una baja previa → el flag debe LIMPIARSE (vuelve a tener TV).
    ctx.tvCancellation.seedCancelled('cust-B');

    const result = await ctx.uc.execute('cust-A', {
      targetCustomerId: 'cust-B', targetContractId: 'C-B', actorId: 'op-1', actorName: 'caro',
    });

    expect(result).toEqual({ cic: CIC, severed: true, targetCleared: true, localSource: 'synced', localTarget: 'synced' });

    // Orden pinned (FIX-3, fix wave 2): guards (get:src, get:tgt 404) → alias → VERIFY →
    // severing → clear destino → resolución+captura del slot origen (sin writes) → reconcile
    // destino (relee cuenta + crea fila) → carry de credenciales al destino (HIGH-2) →
    // inactivación del origen RECIÉN DESPUÉS del write OK del destino → eventos.
    // Por qué el orden nuevo: si el origen se wipeaba ANTES y el destino fallaba, las
    // credenciales no quedaban en NINGUNA fila (pérdida definitiva — la password TV no es
    // re-derivable). Ahora el destino recibe la copia PRIMERO y el origen se limpia después.
    expect(calls).toEqual([
      'get:cust-A',            // guard 4: cuenta origen resuelve
      'get:cust-B',            // guard 5: destino debe dar 404 (o mismo cic = resume)
      'set:alias',             // paso 1: PATCH internal_id (alias append-only)
      'get:cust-B',            // paso 2: VERIFY del alias
      'markCancelled',         // paso 3: severing local del origen
      'clearCancelled',        // paso 4: destino vuelve a tener TV
      'get:cust-B',            // paso 6: reconcile destino relee la cuenta
      'cs.add',                // paso 6: fila TV del contrato destino
      'cs.update',             // paso 6 (HIGH-2): credenciales del origen a la fila destino
      'cs.update',             // paso 6b (FIX-3): slot origen inactivo + credenciales limpias, POST write destino
      'event:transfer-out',    // paso 7: historial origen
      'event:transfer-in',     // paso 7: historial destino
    ]);

    // Flags locales: origen severed, destino limpio.
    expect(await ctx.tvCancellation.isCancelled('cust-A')).toBe(true);
    expect(await ctx.tvCancellation.isCancelled('cust-B')).toBe(false);

    // Slot origen: inactivo, credenciales LIMPIAS (sin zombies).
    const sourceRow = await ctx.cs.getByPair('C-A', ctx.tvCatalogId);
    expect(sourceRow!.status).toBe('inactive');
    expect(sourceRow!.tvLogin).toBeNull();
    expect(sourceRow!.tvPassword).toBeNull();

    // Slot destino: activo con el CIC.
    const targetRow = await ctx.cs.getByPair('C-B', ctx.tvCatalogId);
    expect(targetRow).not.toBeNull();
    expect(targetRow!.status).toBe('active');
    expect(targetRow!.notes).toBe(`CIC ${CIC} · Gigared Play Full`);

    // Payload de AMBOS eventos: modified + changeKind + nombres snapshot + actor + catálogo TV.
    const all = ctx.events.all();
    expect(all).toHaveLength(2);
    const out = all.find((e) => e.changeKind === 'transfer-out')!;
    const inn = all.find((e) => e.changeKind === 'transfer-in')!;
    for (const e of [out, inn]) {
      expect(e.eventType).toBe('modified');
      expect(e.serviceCatalogId).toBe(ctx.tvCatalogId);
      expect(e.oldValue).toBe('Martino Agustina');
      expect(e.newValue).toBe('Martino Marcelo Julián');
      expect(e.actorId).toBe('op-1');
      expect(e.actorName).toBe('caro');
    }
    // transfer-out va al contrato ORIGEN (resuelto por el slot TV activo, sin sourceContractId);
    // transfer-in al DESTINO.
    expect(out.contractId).toBe('C-A');
    expect(inn.contractId).toBe('C-B');
  });

  it('#81 seq: origen con tvActivationSeq=2 resuelve por {id}-2 y aliasa al internal_id VIGENTE del destino', async () => {
    const port = transferPort({ sourceId: 'cust-A-2', targetId: 'cust-B-1' });
    const ctx = await buildCtx({
      port,
      customers: {
        'cust-A': { name: 'A', tvActivationSeq: 2 },
        'cust-B': { name: 'B', tvActivationSeq: 1 },
      },
    });
    const result = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(result.severed).toBe(true);
    expect(port.getAccountByInternalId).toHaveBeenCalledWith('cust-A-2');
    expect(port.setInternalId).toHaveBeenCalledWith(CIC, 'cust-B-1');
  });
});

describe('TransferTvToCustomer — el CUA acepta pero el alias no tomó (F0)', () => {
  it('GET post-PATCH devuelve 404 → GigaredRejectedError y CERO efectos locales', async () => {
    const ctx = await buildCtx({ port: transferPort({ aliasTakes: false }) });
    await expect(ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' }))
      .rejects.toBeInstanceOf(GigaredRejectedError);
    // CERO efectos locales: ni flags, ni slots, ni eventos.
    expect(await ctx.tvCancellation.isCancelled('cust-A')).toBe(false);
    const sourceRow = await ctx.cs.getByPair('C-A', ctx.tvCatalogId);
    expect(sourceRow!.status).toBe('active');
    expect(sourceRow!.tvLogin).toBe('GIGA100');
    expect(sourceRow!.tvPassword).toBe('ip243200');
    expect(await ctx.cs.getByPair('C-B', ctx.tvCatalogId)).toBeNull();
    expect(ctx.events.all()).toHaveLength(0);
  });

  it('GET post-PATCH resuelve a OTRO cic → GigaredRejectedError y CERO efectos locales', async () => {
    const ctx = await buildCtx({ port: transferPort({ aliasCic: '0000007777' }) });
    await expect(ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' }))
      .rejects.toBeInstanceOf(GigaredRejectedError);
    expect(await ctx.tvCancellation.isCancelled('cust-A')).toBe(false);
    expect(ctx.events.all()).toHaveLength(0);
    expect((await ctx.cs.getByPair('C-A', ctx.tvCatalogId))!.status).toBe('active');
  });
});

describe('TransferTvToCustomer — parciales (la op partner NUNCA se revierte)', () => {
  it('markCancelled falla → severed:false y el resto sigue (slots + eventos)', async () => {
    const ctx = await buildCtx();
    jest.spyOn(ctx.tvCancellation, 'markCancelled').mockRejectedValue(new Error('db down'));
    const result = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(result.severed).toBe(false);
    expect(result.localSource).toBe('synced');
    expect(result.localTarget).toBe('synced');
    expect(result.cic).toBe(CIC);
    // El resto siguió: slot origen inactivo, slot destino activo, eventos grabados.
    expect((await ctx.cs.getByPair('C-A', ctx.tvCatalogId))!.status).toBe('inactive');
    expect((await ctx.cs.getByPair('C-B', ctx.tvCatalogId))!.status).toBe('active');
    expect(ctx.events.all()).toHaveLength(2);
  });

  it('reconcile del destino falla → localTarget:"failed" y el origen NO se toca (FIX-3: sigue activo CON credenciales)', async () => {
    // Actualizado al orden FIX-3 (fix wave 2): antes el origen se inactivaba+wipeaba ANTES del
    // write del destino ("el resto queda hecho"); si el destino fallaba, las credenciales no
    // quedaban en NINGUNA fila. Ahora el origen se preserva ACTIVO con credenciales para que el
    // retry resume las encuentre → localSource:'failed' (pendiente deliberado, 207).
    const ctx = await buildCtx();
    // El destino no tiene fila → reconcile crea por add(); lo hacemos fallar.
    jest.spyOn(ctx.cs, 'add').mockRejectedValue(new Error('db down'));
    const result = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(result.severed).toBe(true);
    expect(result.localSource).toBe('failed');
    expect(result.localTarget).toBe('failed');
    // El severing corrió; el slot origen quedó INTACTO (activo + credenciales vivas).
    expect(await ctx.tvCancellation.isCancelled('cust-A')).toBe(true);
    const sourceRow = await ctx.cs.getByPair('C-A', ctx.tvCatalogId);
    expect(sourceRow!.status).toBe('active');
    expect(sourceRow!.tvLogin).toBe('GIGA100');
    expect(sourceRow!.tvPassword).toBe('ip243200');
  });

  it('inactivación del slot origen falla → localSource:"failed", el destino YA quedó escrito con las credenciales', async () => {
    // Actualizado al orden FIX-3 (fix wave 2): la inactivación del origen ahora corre DESPUÉS
    // del write del destino, así que el fallo se targetea por el patch {status:'inactive'} (el
    // primer update ya no es el wipe: es el carry de credenciales al destino).
    const ctx = await buildCtx();
    const realUpdate = ctx.cs.update.bind(ctx.cs);
    jest.spyOn(ctx.cs, 'update').mockImplementation(async (id, data) => {
      if (data.status === 'inactive') throw new Error('db down');
      return realUpdate(id, data);
    });
    const result = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(result.localSource).toBe('failed');
    // El destino se reconcilió PRIMERO (fila nueva vía add) y recibió las credenciales capturadas.
    expect(result.localTarget).toBe('synced');
    const targetRow = await ctx.cs.getByPair('C-B', ctx.tvCatalogId);
    expect(targetRow!.status).toBe('active');
    expect(targetRow!.tvLogin).toBe('GIGA100');
    expect(targetRow!.tvPassword).toBe('ip243200');
    // El wipe fallido dejó la fila origen activa con sus credenciales (copia, no pérdida) — el
    // retry resume la inactiva.
    const sourceRow = await ctx.cs.getByPair('C-A', ctx.tvCatalogId);
    expect(sourceRow!.status).toBe('active');
    expect(sourceRow!.tvLogin).toBe('GIGA100');
  });

  // FIX-3 (fix wave 2) — completar HIGH-2: el orden viejo (wipe del origen ANTES del write del
  // destino) perdía las credenciales PARA SIEMPRE si el destino fallaba: el retry resume
  // reconstruía el slot destino sin credenciales porque findActive… solo ve filas ACTIVAS y la
  // del origen ya estaba inactiva y wipeada. Con el orden nuevo el retry las encuentra.
  it('FIX-3: destino falla → origen sigue ACTIVO con credenciales → el retry resume completa y el destino termina con ellas', async () => {
    const ctx = await buildCtx();
    jest.spyOn(ctx.cs, 'add').mockRejectedValueOnce(new Error('db down'));
    const first = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(first.localTarget).toBe('failed');
    expect(first.localSource).toBe('failed'); // pendiente deliberado: el origen no se tocó

    // Las credenciales SIGUEN en la fila origen, activa → el retry resume las va a ver.
    const sourceAfterFirst = await ctx.cs.getByPair('C-A', ctx.tvCatalogId);
    expect(sourceAfterFirst!.status).toBe('active');
    expect(sourceAfterFirst!.tvLogin).toBe('GIGA100');
    expect(sourceAfterFirst!.tvPassword).toBe('ip243200');

    // Retry (modo resume): completa TODO — destino con credenciales, origen inactivo y wipeado.
    const second = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(second).toEqual({ cic: CIC, severed: true, targetCleared: true, localSource: 'synced', localTarget: 'synced' });
    const targetRow = await ctx.cs.getByPair('C-B', ctx.tvCatalogId);
    expect(targetRow!.status).toBe('active');
    expect(targetRow!.tvLogin).toBe('GIGA100');
    expect(targetRow!.tvPassword).toBe('ip243200');
    const sourceRow = await ctx.cs.getByPair('C-A', ctx.tvCatalogId);
    expect(sourceRow!.status).toBe('inactive');
    expect(sourceRow!.tvLogin).toBeNull();
    expect(sourceRow!.tvPassword).toBeNull();
    expect(ctx.port.setInternalId).toHaveBeenCalledTimes(1);
  });
});

describe('TransferTvToCustomer — TV-2: sin teardown JAMÁS', () => {
  it('éxito: el GigaredPort NUNCA recibió removeService/setOtt/renewCic', async () => {
    const ctx = await buildCtx();
    await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(ctx.port.removeService).not.toHaveBeenCalled();
    expect(ctx.port.setOtt).not.toHaveBeenCalled();
    expect(ctx.port.renewCic).not.toHaveBeenCalled();
  });

  it('parcial (severing falla): tampoco hay teardown', async () => {
    const ctx = await buildCtx();
    jest.spyOn(ctx.tvCancellation, 'markCancelled').mockRejectedValue(new Error('db down'));
    await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(ctx.port.removeService).not.toHaveBeenCalled();
    expect(ctx.port.setOtt).not.toHaveBeenCalled();
    expect(ctx.port.renewCic).not.toHaveBeenCalled();
  });
});

describe('TransferTvToCustomer — sourceContractId y resolución del contrato origen', () => {
  it('con sourceContractId: usa ese contrato para el slot y el evento transfer-out', async () => {
    const ctx = await buildCtx();
    const result = await ctx.uc.execute('cust-A', {
      targetCustomerId: 'cust-B', targetContractId: 'C-B', sourceContractId: 'C-A',
    });
    expect(result.localSource).toBe('synced');
    expect((await ctx.cs.getByPair('C-A', ctx.tvCatalogId))!.status).toBe('inactive');
    const out = ctx.events.all().find((e) => e.changeKind === 'transfer-out')!;
    expect(out.contractId).toBe('C-A');
  });

  it('sin sourceContractId y sin slot origen resoluble → transfer-out se OMITE con warn, transfer-in igual se graba', async () => {
    const ctx = await buildCtx({ seedSourceRow: false });
    const result = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    // No había fila local del origen: nada que inactivar → synced (vacuamente).
    expect(result.localSource).toBe('synced');
    const all = ctx.events.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.changeKind).toBe('transfer-in');
    expect(warnSpy).toHaveBeenCalled();
  });

  // MEDIUM-3a — sourceContractId explícito se VALIDA (espejo del guard 3): existe y pertenece
  // al cliente ORIGEN, ANTES de tocar Gigared. Sin esto, un id basura pasaba en silencio.
  it('MEDIUM-3a: sourceContractId inexistente → ContractNotFoundError ANTES de tocar Gigared', async () => {
    const ctx = await buildCtx();
    await expect(ctx.uc.execute('cust-A', {
      targetCustomerId: 'cust-B', targetContractId: 'C-B', sourceContractId: 'ghost',
    })).rejects.toBeInstanceOf(ContractNotFoundError);
    expect(ctx.port.getAccountByInternalId).not.toHaveBeenCalled();
    expect(ctx.port.setInternalId).not.toHaveBeenCalled();
    expect(ctx.events.all()).toHaveLength(0);
  });

  it('MEDIUM-3a: sourceContractId AJENO (no pertenece al cliente ORIGEN) → ContractNotFoundError sin leak', async () => {
    const ctx = await buildCtx();
    // C-B pertenece a cust-B, no al origen cust-A → 404 sin revelar que el contrato existe.
    await expect(ctx.uc.execute('cust-A', {
      targetCustomerId: 'cust-B', targetContractId: 'C-B', sourceContractId: 'C-B',
    })).rejects.toBeInstanceOf(ContractNotFoundError);
    expect(ctx.port.setInternalId).not.toHaveBeenCalled();
    expect((await ctx.cs.getByPair('C-A', ctx.tvCatalogId))!.status).toBe('active');
  });

  // MEDIUM-3b — precedencia INVERTIDA: la fila realmente inactivada (resolved) manda sobre el
  // input para el evento transfer-out.
  it('MEDIUM-3b: el evento transfer-out usa el contrato de la fila REALMENTE inactivada, no el input', async () => {
    // C-X es del origen y existe, pero su slot no registra el cic; el slot real vive en C-A.
    const ctx = await buildCtx({ contracts: { 'C-A': 'cust-A', 'C-X': 'cust-A', 'C-B': 'cust-B' } });
    const result = await ctx.uc.execute('cust-A', {
      targetCustomerId: 'cust-B', targetContractId: 'C-B', sourceContractId: 'C-X',
    });
    expect(result.localSource).toBe('synced');
    expect((await ctx.cs.getByPair('C-A', ctx.tvCatalogId))!.status).toBe('inactive');
    const out = ctx.events.all().find((e) => e.changeKind === 'transfer-out')!;
    expect(out.contractId).toBe('C-A');
  });
});

describe('TransferTvToCustomer — HIGH-1: resume de parciales (retry re-ejecutable)', () => {
  it('(a) retry tras severed:false completa el severing SIN re-aliasar (setInternalId 1 sola vez)', async () => {
    const ctx = await buildCtx();
    // Primer intento: el severing falla → 207 con severed:false. El alias del partner YA quedó.
    jest.spyOn(ctx.tvCancellation, 'markCancelled').mockRejectedValueOnce(new Error('db down'));
    const first = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(first.severed).toBe(false);

    // Retry del MISMO request: el destino ya resuelve al MISMO cic → modo RESUME (no 409, no PATCH).
    const second = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(second).toEqual({ cic: CIC, severed: true, targetCleared: true, localSource: 'synced', localTarget: 'synced' });
    expect(ctx.port.setInternalId).toHaveBeenCalledTimes(1);
    expect(await ctx.tvCancellation.isCancelled('cust-A')).toBe(true);

    // HIGH-2 en resume: el destino NO pierde las credenciales que le llevó el primer intento
    // (la fila origen ya fue wipeada — no hay nada que llevar, y lo existente no se pisa).
    const targetRow = await ctx.cs.getByPair('C-B', ctx.tvCatalogId);
    expect(targetRow!.status).toBe('active');
    expect(targetRow!.tvLogin).toBe('GIGA100');
    expect(targetRow!.tvPassword).toBe('ip243200');
  });

  it('(b) retry tras localTarget:"failed" (origen YA cancelado) NO da 404 y completa el slot destino', async () => {
    const ctx = await buildCtx();
    jest.spyOn(ctx.cs, 'add').mockRejectedValueOnce(new Error('db down'));
    const first = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(first.localTarget).toBe('failed');
    expect(first.severed).toBe(true);
    // El origen quedó cancelado localmente — el guard viejo hubiera dado TvNotLinkedError acá.
    expect(await ctx.tvCancellation.isCancelled('cust-A')).toBe(true);

    const second = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(second.localTarget).toBe('synced');
    expect(second.severed).toBe(true);
    expect((await ctx.cs.getByPair('C-B', ctx.tvCatalogId))!.status).toBe('active');
    expect(ctx.port.setInternalId).toHaveBeenCalledTimes(1);
  });

  it('(c) destino vinculado a OTRO cic NO es resume: sigue el 409 de siempre', async () => {
    // (El guard test "destino YA vinculado" cubre el pre-PATCH; este pin asegura que el modo
    // resume SOLO aplica con cic idéntico.)
    const ctx = await buildCtx({ port: transferPort({ targetPreLinkedCic: '0000009999' }) });
    await expect(ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' }))
      .rejects.toBeInstanceOf(TvAlreadyLinkedError);
    expect(ctx.port.setInternalId).not.toHaveBeenCalled();
  });

  it('(d) origen sin TV upstream y destino sin TV → TvNotLinkedError (404) como siempre', async () => {
    const ctx = await buildCtx({ port: transferPort({ sourceMissing: true }) });
    await expect(ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' }))
      .rejects.toBeInstanceOf(TvNotLinkedError);
    expect(ctx.port.setInternalId).not.toHaveBeenCalled();
  });
});

describe('TransferTvToCustomer — FIX WAVE 2 / FIX-2: guard A→A (source == target)', () => {
  it('A→A → TvAlreadyLinkedError (409, espejo del guard 3 de TransferPppoe), CERO llamadas al port y CERO efectos', async () => {
    // Sin el guard, A→A resolvía ambos lados al MISMO cic (mismo internal_id) y entraba en modo
    // RESUME: mark+clear del flag del propio cliente + re-reconcile de su slot. Pre-fix daba 409.
    const ctx = await buildCtx();
    const markSpy = jest.spyOn(ctx.tvCancellation, 'markCancelled');
    const clearSpy = jest.spyOn(ctx.tvCancellation, 'clearCancelled');

    await expect(ctx.uc.execute('cust-A', { targetCustomerId: 'cust-A', targetContractId: 'C-A' }))
      .rejects.toBeInstanceOf(TvAlreadyLinkedError);

    // ANTES de cualquier llamada al partner (espejo TransferPppoe guard 3, que corre pre-I/O externo).
    expect(ctx.port.getAccountByInternalId).not.toHaveBeenCalled();
    expect(ctx.port.setInternalId).not.toHaveBeenCalled();
    // Cero efectos locales: flags intactos, slot intacto, cero eventos.
    expect(markSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    const row = await ctx.cs.getByPair('C-A', ctx.tvCatalogId);
    expect(row!.status).toBe('active');
    expect(row!.tvLogin).toBe('GIGA100');
    expect(ctx.events.all()).toHaveLength(0);
  });
});

describe('TransferTvToCustomer — FIX WAVE 2 / FIX-1: el resume se gobierna por ownership LOCAL (F0)', () => {
  it('replay A→B viejo tras A→C completa → TvAlreadyLinkedError (409) y CERO mutaciones (el dueño local vigente es C)', async () => {
    // Escenario del hijack: A→B parcial (207) dejó el alias cust-B→cic en el CUA (append-only,
    // JAMÁS se borra). Después A→C corrió COMPLETA: C es el dueño local vigente (fila managed
    // ACTIVA en C-C con las credenciales). El replay del POST A→B viejo resuelve cust-B al mismo
    // cic → el resume upstream-only inactivaba la fila ACTIVA de C, le robaba las credenciales
    // y respondía 200. El ownership local manda sobre el alias upstream (F0).
    const ctx = await buildCtx({
      port: transferPort({ targetPreLinkedCic: CIC }), // cust-B resuelve al MISMO cic (alias residual)
      customers: {
        'cust-A': { name: 'Martino Agustina' },
        'cust-B': { name: 'Martino Marcelo Julián' },
        'cust-C': { name: 'Tercero Carlos' },
      },
      contracts: { 'C-A': 'cust-A', 'C-B': 'cust-B', 'C-C': 'cust-C' },
      seedSourceRow: false,
    });
    // Estado local post "A→C completa": C tiene la fila managed ACTIVA con las credenciales;
    // la fila del origen A quedó inactiva y wipeada; A quedó severed (tvCancelledAt).
    const cRow = await ctx.cs.add({
      contractId: 'C-C', serviceCatalogId: ctx.tvCatalogId,
      notes: `CIC ${CIC} · Gigared Play Full`, tvLogin: 'GIGA100', tvPassword: 'ip243200',
    });
    const aRow = await ctx.cs.add({
      contractId: 'C-A', serviceCatalogId: ctx.tvCatalogId, notes: `CIC ${CIC} · Gigared Play Full`,
    });
    await ctx.cs.update(aRow.id, { status: 'inactive', tvLogin: null, tvPassword: null });
    ctx.tvCancellation.seedCancelled('cust-A');

    const markSpy = jest.spyOn(ctx.tvCancellation, 'markCancelled');
    const clearSpy = jest.spyOn(ctx.tvCancellation, 'clearCancelled');
    const updateSpy = jest.spyOn(ctx.cs, 'update');
    const addSpy = jest.spyOn(ctx.cs, 'add');

    await expect(ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' }))
      .rejects.toBeInstanceOf(TvAlreadyLinkedError);

    // CERO mutaciones: ni setInternalId, ni flags, ni slots, ni eventos.
    expect(ctx.port.setInternalId).not.toHaveBeenCalled();
    expect(markSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();
    // La fila ACTIVA de C sigue intacta CON sus credenciales (nada de robo).
    const cAfter = await ctx.cs.getById(cRow.id);
    expect(cAfter!.status).toBe('active');
    expect(cAfter!.tvLogin).toBe('GIGA100');
    expect(cAfter!.tvPassword).toBe('ip243200');
    // B no ganó slot; los flags quedaron como estaban.
    expect(await ctx.cs.getByPair('C-B', ctx.tvCatalogId)).toBeNull();
    expect(await ctx.tvCancellation.isCancelled('cust-A')).toBe(true);
    expect(ctx.events.all()).toHaveLength(0);
  });

  it('el resume LEGÍTIMO (A→B parcial, retry A→B, filas locales solo de origen/destino) sigue devolviendo 200', async () => {
    // Pin explícito del FIX-1: el cross-check local NO rompe el resume real — las filas activas
    // con el cic pertenecen al origen (aún no inactivada) o al destino (ya reconciliada).
    const ctx = await buildCtx();
    jest.spyOn(ctx.tvCancellation, 'markCancelled').mockRejectedValueOnce(new Error('db down'));
    const first = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(first.severed).toBe(false);

    const second = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(second).toEqual({ cic: CIC, severed: true, targetCleared: true, localSource: 'synced', localTarget: 'synced' });
    expect(ctx.port.setInternalId).toHaveBeenCalledTimes(1);
  });
});

describe('TransferTvToCustomer — HIGH-2: carry de credenciales TV al slot destino', () => {
  it('happy: la fila DESTINO recibe tvLogin/tvPassword del origen y el origen queda null', async () => {
    const ctx = await buildCtx();
    await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });

    const sourceRow = await ctx.cs.getByPair('C-A', ctx.tvCatalogId);
    expect(sourceRow!.tvLogin).toBeNull();
    expect(sourceRow!.tvPassword).toBeNull();

    const targetRow = await ctx.cs.getByPair('C-B', ctx.tvCatalogId);
    expect(targetRow!.tvLogin).toBe('GIGA100');
    expect(targetRow!.tvPassword).toBe('ip243200');
  });

  it('origen sin credenciales → no se escribe nada en el destino (sin nulls forzados)', async () => {
    const ctx = await buildCtx({ seedSourceRow: false });
    const row = await ctx.cs.add({
      contractId: 'C-A', serviceCatalogId: ctx.tvCatalogId,
      notes: `CIC ${CIC} · Gigared Play Full`,
    });
    void row;
    const result = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(result.localTarget).toBe('synced');
    const targetRow = await ctx.cs.getByPair('C-B', ctx.tvCatalogId);
    expect(targetRow!.tvLogin).toBeNull();
    expect(targetRow!.tvPassword).toBeNull();
  });
});

describe('TransferTvToCustomer — MEDIUM-1: resolución del slot origen por cic EXACTO y en TODAS las filas', () => {
  it('colisión de prefijo: "CIC {cic}9" NO se confunde — se inactiva la fila del cic exacto aunque sea más nueva', async () => {
    const ctx = await buildCtx({ seedSourceRow: false });
    // La fila de la colisión es MÁS VIEJA (el findFirst viejo la agarraba y dejaba zombie la real).
    const collision = await ctx.cs.add({
      contractId: 'C-Z', serviceCatalogId: ctx.tvCatalogId, notes: `CIC ${CIC}9 · Otro pack`,
    });
    const real = await ctx.cs.add({
      contractId: 'C-A', serviceCatalogId: ctx.tvCatalogId,
      notes: `CIC ${CIC} · Gigared Play Full`, tvLogin: 'GIGA100', tvPassword: 'ip243200',
    });

    const result = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(result.localSource).toBe('synced');

    // La fila REAL se inactivó; la de la colisión sigue activa e intacta.
    expect((await ctx.cs.getById(real.id))!.status).toBe('inactive');
    const collisionRow = await ctx.cs.getById(collision.id);
    expect(collisionRow!.status).toBe('active');
    expect(collisionRow!.notes).toBe(`CIC ${CIC}9 · Otro pack`);

    // Y el transfer-out salió al contrato REAL, resuelto por cic exacto.
    const out = ctx.events.all().find((e) => e.changeKind === 'transfer-out')!;
    expect(out.contractId).toBe('C-A');
  });

  it('dos filas activas con el MISMO cic (data sucia / residuo de parciales) → se inactivan TODAS', async () => {
    const ctx = await buildCtx(); // fila managed en C-A (más vieja)
    const residue = await ctx.cs.add({
      contractId: 'C-OLD', serviceCatalogId: ctx.tvCatalogId, notes: `CIC ${CIC} · Residuo parcial`,
    });

    const result = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(result.localSource).toBe('synced');
    expect((await ctx.cs.getByPair('C-A', ctx.tvCatalogId))!.status).toBe('inactive');
    expect((await ctx.cs.getById(residue.id))!.status).toBe('inactive');
    // El destino no se ve afectado por la limpieza multi-fila.
    expect((await ctx.cs.getByPair('C-B', ctx.tvCatalogId))!.status).toBe('active');
  });
});

describe('TransferTvToCustomer — MEDIUM-2: clearCancelled(destino) visible en el resultado', () => {
  it('clearCancelled lanza → targetCleared:false (el resto sigue)', async () => {
    const ctx = await buildCtx();
    jest.spyOn(ctx.tvCancellation, 'clearCancelled').mockRejectedValue(new Error('db down'));
    const result = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(result.targetCleared).toBe(false);
    expect(result.severed).toBe(true);
    expect(result.localSource).toBe('synced');
    expect(result.localTarget).toBe('synced');
  });
});

describe('TransferTvToCustomer — service-transfer TV-3: evento transferencia en el Historial TV global', () => {
  it('transferencia fresh exitosa → graba DOS eventos transferencia (destino + origen), reason legible, cic', async () => {
    const ctx = await buildCtx();
    await ctx.uc.execute('cust-A', {
      targetCustomerId: 'cust-B', targetContractId: 'C-B', actorId: 'op-1', actorName: 'caro',
    });

    const record = ctx.activationEventRepo.record as jest.Mock;
    expect(record).toHaveBeenCalledTimes(2);

    const destinoCall = record.mock.calls.find((c) => c[0].clientId === 'cust-B')![0];
    expect(destinoCall).toMatchObject({
      clientId:    'cust-B',
      eventType:   'transferencia',
      internalId:  'cust-B',
      contractId:  'C-B',
      cic:         CIC,
      actorId:     'op-1',
      actorName:   'caro',
    });
    expect(destinoCall.reason).toEqual(expect.any(String));
    expect(destinoCall.reason.length).toBeGreaterThan(0);

    const origenCall = record.mock.calls.find((c) => c[0].clientId === 'cust-A')![0];
    expect(origenCall).toMatchObject({
      clientId:   'cust-A',
      eventType:  'transferencia',
      internalId: 'cust-A',
      cic:        CIC,
      actorId:    'op-1',
      actorName:  'caro',
    });
    expect(origenCall.reason).toEqual(expect.any(String));
    expect(origenCall.reason.length).toBeGreaterThan(0);
  });

  it('modo RESUME (retry post-parcial) re-graba los DOS eventos transferencia (append-only)', async () => {
    const ctx = await buildCtx();
    jest.spyOn(ctx.tvCancellation, 'markCancelled').mockRejectedValueOnce(new Error('db down'));
    await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    const record = ctx.activationEventRepo.record as jest.Mock;
    expect(record).toHaveBeenCalledTimes(2);

    // Retry (resume): setInternalId NO se re-llama, pero los eventos transferencia SÍ se re-graban.
    await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(record).toHaveBeenCalledTimes(4);
  });

  it('activationEventRepo.record rechaza → la transferencia COMPLETA igual, sin excepción propagada', async () => {
    const ctx = await buildCtx();
    (ctx.activationEventRepo.record as jest.Mock).mockRejectedValue(new Error('event store down'));

    const result = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(result).toEqual({ cic: CIC, severed: true, targetCleared: true, localSource: 'synced', localTarget: 'synced' });
  });

  it('SIN activationEventRepo inyectado → comportamiento BYTE-IDÉNTICO (cero llamadas nuevas)', async () => {
    const ctx = await buildCtx({ withActivationEventRepo: false });
    const result = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(result).toEqual({ cic: CIC, severed: true, targetCleared: true, localSource: 'synced', localTarget: 'synced' });
  });
});

describe('TransferTvToCustomer — MEDIUM-5: eventos legibles en la ficha', () => {
  it('las notes de ambos eventos dicen de quién a quién: "CIC {cic} — de {origen} a {destino}"', async () => {
    const ctx = await buildCtx();
    await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    const all = ctx.events.all();
    expect(all).toHaveLength(2);
    for (const e of all) {
      expect(e.notes).toBe(`CIC ${CIC} — de Martino Agustina a Martino Marcelo Julián`);
    }
  });
});

describe('TransferTvToCustomer — FIX WAVE 3: cross-check de ownership LOCAL incondicional (no-resume incluido)', () => {
  it('POST A→B con B FRESCO (404 upstream) tras A→C parcial con severed:false → 409 con el id de C y CERO mutaciones', async () => {
    // Escenario del robo por el camino NO-resume: A→C corrió PARCIAL con severed:false —
    // localTarget synced (C ya tiene la fila managed ACTIVA con las credenciales) y la fila de A
    // quedó inactiva y wipeada (6b), pero markCancelled(A) falló → A quedó SIN flag. Después
    // llega un POST A→B con B fresco: su internal_id da 404 upstream → NO es resume. Pre-fix el
    // cross-check 5b corría SOLO dentro de `if (resume)`: se aliasaba B, el paso 5 capturaba las
    // credenciales de la fila ACTIVA de C (registra el MISMO cic) y el 6b la inactivaba — robo
    // silencioso con 200. El ownership local manda SIEMPRE, no solo en resume → 409 con el
    // customerId del dueño vigente (C), ANTES de setInternalId, cero mutaciones.
    const ctx = await buildCtx({
      customers: {
        'cust-A': { name: 'Martino Agustina' },
        'cust-B': { name: 'Martino Marcelo Julián' },
        'cust-C': { name: 'Tercero Carlos' },
      },
      contracts: { 'C-A': 'cust-A', 'C-B': 'cust-B', 'C-C': 'cust-C' },
      seedSourceRow: false,
    });
    // Estado local post "A→C parcial (severed:false)": C con la fila ACTIVA + credenciales;
    // la fila de A inactiva y wipeada; A SIN flag de baja (el severing fue lo que falló).
    const cRow = await ctx.cs.add({
      contractId: 'C-C', serviceCatalogId: ctx.tvCatalogId,
      notes: `CIC ${CIC} · Gigared Play Full`, tvLogin: 'GIGA100', tvPassword: 'ip243200',
    });
    const aRow = await ctx.cs.add({
      contractId: 'C-A', serviceCatalogId: ctx.tvCatalogId, notes: `CIC ${CIC} · Gigared Play Full`,
    });
    await ctx.cs.update(aRow.id, { status: 'inactive', tvLogin: null, tvPassword: null });

    const markSpy = jest.spyOn(ctx.tvCancellation, 'markCancelled');
    const clearSpy = jest.spyOn(ctx.tvCancellation, 'clearCancelled');
    const updateSpy = jest.spyOn(ctx.cs, 'update');
    const addSpy = jest.spyOn(ctx.cs, 'add');

    await expect(ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' }))
      .rejects.toMatchObject({ name: 'TvAlreadyLinkedError', customerId: 'cust-C', cic: CIC });

    // CERO mutaciones: ni alias en el partner, ni flags, ni slots, ni eventos.
    expect(ctx.port.setInternalId).not.toHaveBeenCalled();
    expect(markSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();
    // La fila ACTIVA de C intacta CON sus credenciales; B no ganó slot; A sigue sin flag.
    const cAfter = await ctx.cs.getById(cRow.id);
    expect(cAfter!.status).toBe('active');
    expect(cAfter!.tvLogin).toBe('GIGA100');
    expect(cAfter!.tvPassword).toBe('ip243200');
    expect(await ctx.cs.getByPair('C-B', ctx.tvCatalogId)).toBeNull();
    expect(await ctx.tvCancellation.isCancelled('cust-A')).toBe(false);
    expect(ctx.events.all()).toHaveLength(0);
  });

  // Pin del caso Martino (el que originó el EPIC): la transferencia se hizo A MANO por DB /
  // soporte del partner — el alias upstream ya apunta el internal_id del destino al cic, y
  // localmente NO queda NINGUNA fila managed con ese cic. El cross-check no encuentra dueño
  // local que proteger → el resume procede y FORMALIZA el estado: flags + slot destino + evento.
  it('caso Martino — resume con CERO filas managed locales → aceptado (200): el transfer hecho a mano se formaliza', async () => {
    const ctx = await buildCtx({ port: transferPort({ targetPreLinkedCic: CIC }), seedSourceRow: false });
    const result = await ctx.uc.execute('cust-A', { targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(result).toEqual({ cic: CIC, severed: true, targetCleared: true, localSource: 'synced', localTarget: 'synced' });

    // Resume: JAMÁS se re-aliasa el partner.
    expect(ctx.port.setInternalId).not.toHaveBeenCalled();
    // Formaliza: origen severed, destino limpio y con el slot reconstruido de la cuenta partner.
    expect(await ctx.tvCancellation.isCancelled('cust-A')).toBe(true);
    expect(await ctx.tvCancellation.isCancelled('cust-B')).toBe(false);
    const targetRow = await ctx.cs.getByPair('C-B', ctx.tvCatalogId);
    expect(targetRow!.status).toBe('active');
    expect(targetRow!.notes).toBe(`CIC ${CIC} · Gigared Play Full`);
    // Sin fila origen local no hay transfer-out resoluble (se omite con warn); el transfer-in queda.
    const all = ctx.events.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.changeKind).toBe('transfer-in');
  });
});
