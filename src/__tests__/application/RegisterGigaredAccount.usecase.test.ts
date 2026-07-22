/**
 * #109 — RegisterGigaredAccount: CIC se asigna automáticamente del pool de cuentas
 * 'unregistered' (ya no lo elige el operador desde el FE).
 *
 * (a) Pool vacío → NoCicAvailableError (antes de tocar Gigared).
 * (b) Pool con N cuentas unregistered → registra/activa con el CIC elegido por el selector.
 *     Con el `pick` inyectado el test es determinístico.
 *
 * #115 — la identidad determinística de TV (password + email) deriva del grContratoId del
 * CONTRATO, no del grClienteId del cliente. contractId es REQUERIDO para el alta.
 */
import { RegisterGigaredAccount } from '@application/use-cases/gigared/RegisterGigaredAccount';
import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import {
  NoCicAvailableError,
  GrClientIdRequiredError,
  GrContractIdRequiredError,
  TvPoolPoisonedError,
  TvIdentityStampUnverifiedError,
  TvEmailOwnedByOtherError,
  GigaredNotFoundError,
  GigaredRejectedError,
  GigaredUnavailableError,
} from '@domain/errors/gigared';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { deterministicTvPassword, deterministicTvEmail } from '@infrastructure/security/gigaredPassword';
import { currentTvInternalId } from '@domain/gigared/tvIdentity';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryClientTvCancellationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvCancellationRepository';
import { InMemoryClientTvActivationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvActivationRepository';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  const base: GigaredAccount = {
    cic: '0000000001', gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '2026-01-19', services: [], internalId: 'cust-1', clientId: 'cust-1', ott: null,
  };
  return { ...base, ...over };
}

/**
 * B2 (D2) — el register hace un PROBE `getAccountByInternalId` ANTES del pool-pick (idempotencia).
 * Este archivo es EXCLUSIVO de RegisterGigaredAccount (ningún otro use case usa este `fakePort`),
 * así que el default puede reflejar el probe realista: la 1ra llamada (el probe) 404ea — todavía no
 * hay nada estampado — y las siguientes (el readback post-stamp) resuelven al account final.
 */
function probeMissThenFound(final: GigaredAccount = fakeAccount()): jest.Mock {
  return jest.fn()
    .mockRejectedValueOnce(new GigaredNotFoundError())
    .mockResolvedValue(final);
}

function fakePort(over: Partial<GigaredPort> = {}): GigaredPort {
  return {
    getSummary:            jest.fn(),
    listAccounts:          jest.fn(async () => []),
    getAccountByInternalId: probeMissThenFound(),
    getAccountByCic:       jest.fn(async () => fakeAccount()),
    register:              jest.fn(async () => {}),
    activate:              jest.fn(async () => {}),
    setInternalId:         jest.fn(async () => {}),
    addService:            jest.fn(async () => {}),
    removeService:         jest.fn(async () => {}),
    setOtt:                jest.fn(async () => {}),
    changePassword:        jest.fn(async () => {}),
    renewCic:              jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' })),
    ...over,
  };
}

/**
 * Customer lookup minimal — grClienteId puede existir pero ya NO se usa para el alta TV.
 * Lo mantenemos en el shape (otros use cases lo usan); el alta lo ignora.
 *
 * B8 (D1) — `name` viaja opcional para los tests que ejercitan la derivación BE-authoritative
 * del nombre (`splitCustomerName`). Default neutro ('CLIENTE TEST') para no romper los tests
 * que no lo necesitan (Desvíos #4).
 */
function fakeCustomerLookup(found = true, grClienteId = '999999', name = 'CLIENTE TEST') {
  return {
    findById: async (id: string) =>
      found ? { id, grClienteId, name } : null,
  };
}

/**
 * Contract lookup in-memory. Por defecto el contrato pertenece a 'cust-1' con grContratoId='204382'.
 */
function fakeContractLookup(opts: {
  found?: boolean;
  clientId?: string;
  grContratoId?: string | null;
} = {}) {
  const { found = true, clientId = 'cust-1', grContratoId = '204382' } = opts;
  return {
    findById: async (id: string) =>
      found ? { id, clientId, grContratoId } : null,
  };
}

/** Pick determinístico: siempre devuelve el índice 0. */
const pickFirst = (_n: number) => 0;

/** Input mínimo para el use case — contractId REQUERIDO en el nuevo diseño. */
const minInput = (contractId = 'contract-1') => ({
  firstName: 'Juan',
  lastName: 'Pérez',
  email: 'juan@example.com',
  sendActivationEmail: false,
  contractId,
});

/**
 * Pool de una cuenta para que el use case no falle en NoCicAvailableError.
 * B1 (D-pool): la cuenta debe ser LIMPIA (internalId: null) — de lo contrario el anti-poison la
 * descarta y el pool queda TODO envenenado (TvPoolPoisonedError) en vez de proceder al happy path.
 */
function poolOf(cic: string) {
  return jest.fn(async () => [fakeAccount({ cic, internalId: null })]);
}

/**
 * F1 — puerto Gigared CON ESTADO para los tests de re-alta idempotente. El partner "recuerda" los
 * stamps (setInternalId escribe en un Map internalId→cic; getAccountByInternalId lee de ahí). Modela
 * el ciclo real de retry: el intento 1 estampa la cuenta pero el readback post-stamp puede 404ear
 * transitorio (lag de replicación → TvIdentityStampUnverifiedError vía F3); el intento 2 (retry) la
 * reancla vía probe. `readbackFailsOnce` gatilla ese 404 transitorio en el PRIMER readback post-stamp.
 */
function statefulRealtaPort(opts: { poolCic: string; readbackFailsOnce?: boolean }) {
  const stamps = new Map<string, string>(); // internalId -> cic
  let readbackPending = opts.readbackFailsOnce ?? false;
  const register = jest.fn(async () => {});
  const activate = jest.fn(async () => {});
  const setInternalId = jest.fn(async (cic: string, internalId: string) => { stamps.set(internalId, cic); });
  const getAccountByInternalId = jest.fn(async (internalId: string) => {
    if (!stamps.has(internalId)) throw new GigaredNotFoundError();
    // El primer readback post-stamp 404ea transitorio (la identidad aún no confirma); los probes
    // posteriores (el retry) sí la encuentran.
    if (readbackPending) { readbackPending = false; throw new GigaredNotFoundError(); }
    return fakeAccount({ cic: stamps.get(internalId)!, internalId });
  });
  const listAccounts = jest.fn(async () => [fakeAccount({ cic: opts.poolCic, internalId: null })]);
  const port = fakePort({ register, activate, setInternalId, getAccountByInternalId, listAccounts });
  return { port, register, activate, setInternalId, getAccountByInternalId, listAccounts };
}

// ---------------------------------------------------------------------------
// Tests heredados #109 (ajustados: pasan contractId + contractLookup)
// ---------------------------------------------------------------------------

describe('RegisterGigaredAccount #109 — CIC automático del pool', () => {

  it('(a) pool vacío → lanza NoCicAvailableError ANTES de tocar Gigared', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => []),
    });
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), fakeContractLookup());

    await expect(uc.execute('cust-1', minInput()))
      .rejects.toBeInstanceOf(NoCicAvailableError);

    expect(port.register).not.toHaveBeenCalled();
    expect(port.activate).not.toHaveBeenCalled();
  });

  it('(a) pool vacío → error con code NO_CIC_AVAILABLE', async () => {
    const port = fakePort({ listAccounts: jest.fn(async () => []) });
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), fakeContractLookup());

    const err = await uc.execute('cust-1', minInput()).catch(e => e);
    expect((err as NoCicAvailableError).code).toBe('NO_CIC_AVAILABLE');
  });

  it('(b) pool con 3 cuentas → usa la elegida por el selector inyectado (índice 1 → cic "B")', async () => {
    // B1 (D-pool): las 3 deben ser LIMPIAS (internalId: null) para que el anti-poison no las
    // descarte — el `clean` filtrado preserva el orden, así que el índice 1 sigue siendo "B".
    const poolAccounts: GigaredAccount[] = [
      fakeAccount({ cic: 'A', internalId: null }),
      fakeAccount({ cic: 'B', internalId: null }),
      fakeAccount({ cic: 'C', internalId: null }),
    ];
    const port = fakePort({
      listAccounts: jest.fn(async () => poolAccounts),
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: 'B' })),
    });
    const pick = (_n: number) => 1;

    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), fakeContractLookup(), undefined, undefined, undefined, undefined, undefined, pick);
    const result = await uc.execute('cust-1', minInput());

    expect(port.listAccounts).toHaveBeenCalledWith({ status: 'unregistered' });
    expect(port.register).toHaveBeenCalledWith(expect.objectContaining({ cic: 'B' }));
    expect(port.activate).toHaveBeenCalledWith(expect.objectContaining({ cic: 'B' }));
    expect(port.setInternalId).toHaveBeenCalledWith('B', expect.any(String));
    expect(result).toHaveProperty('account');
  });

  it('(b) pool con 1 cuenta → selector elige índice 0 (único disponible)', async () => {
    const singleAccount = fakeAccount({ cic: 'ONLY1', internalId: null }); // B1: LIMPIA
    const port = fakePort({
      listAccounts: jest.fn(async () => [singleAccount]),
      getAccountByInternalId: probeMissThenFound(singleAccount),
    });
    const pick = (_n: number) => 0;

    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), fakeContractLookup(), undefined, undefined, undefined, undefined, undefined, pick);
    await uc.execute('cust-1', minInput());

    expect(port.register).toHaveBeenCalledWith(expect.objectContaining({ cic: 'ONLY1' }));
    expect(port.activate).toHaveBeenCalledWith(expect.objectContaining({ cic: 'ONLY1' }));
  });

  it('cliente inexistente → ClientNotFoundError (sin tocar el pool)', async () => {
    const port = fakePort();
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(false), fakeContractLookup());

    await expect(uc.execute('ghost', minInput()))
      .rejects.toBeInstanceOf(ClientNotFoundError);

    expect(port.listAccounts).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FIX 1 — CIC vacío (cic: '') en el pool → con B1 (D-pool), el filtro `clean` exige `e.cic`
// truthy, así que una entrada con cic:'' queda descartada IGUAL que una envenenada. Si es la
// ÚNICA entrada del pool, `clean` queda vacío → TvPoolPoisonedError (422), NO NoCicAvailableError
// (ese código sigue reservado a "pool.length === 0", el pool crudo vacío — ver #109(a)). Ambos
// tests se actualizan para reflejar esta consecuencia NATURAL del anti-poison (no un cambio
// arbitrario): desde la perspectiva del subconjunto "limpio", un cic vacío es tan inutilizable
// como uno envenenado.
// FIX W2 — pick fuera de rango sobre `clean` → NoCicAvailableError (no TypeError opaco), sin cambios.
// ---------------------------------------------------------------------------

describe('RegisterGigaredAccount — FIX 1 + W2: guard cic falsy / índice fuera de rango', () => {

  it('FIX 1 (B1): pool con ÚNICA cuenta de cic vacío ("") → TvPoolPoisonedError (no pasa a Gigared)', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [fakeAccount({ cic: '' })]),
    });
    const pick = (_n: number) => 0;
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), fakeContractLookup(), undefined, undefined, undefined, undefined, undefined, pick);

    await expect(uc.execute('cust-1', minInput()))
      .rejects.toBeInstanceOf(TvPoolPoisonedError);

    expect(port.register).not.toHaveBeenCalled();
    expect(port.activate).not.toHaveBeenCalled();
  });

  it('FIX 1 (B1): error lanzado tiene code TV_POOL_POISONED (no TypeError)', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [fakeAccount({ cic: '' })]),
    });
    const pick = (_n: number) => 0;
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), fakeContractLookup(), undefined, undefined, undefined, undefined, undefined, pick);

    const err = await uc.execute('cust-1', minInput()).catch(e => e);
    expect(err).toBeInstanceOf(TvPoolPoisonedError);
    expect((err as TvPoolPoisonedError).code).toBe('TV_POOL_POISONED');
  });

  it('F5(a): pool con ÚNICA cuenta de cic vacío pero SIN estampar (internalId null) → NoCicAvailableError, NO TvPoolPoisonedError', async () => {
    // F5(a) — un entry sin cic NO es "veneno" (veneno = tiene internal_id de un dueño ajeno). Si el
    // único problema del pool son entries sin cic (cero envenenados), es indistinto de "no hay CIC
    // disponible" → NoCicAvailableError, no TvPoolPoisonedError. `poisonedCount` sólo cuenta los que
    // tienen internal_id seteado.
    const port = fakePort({
      listAccounts: jest.fn(async () => [fakeAccount({ cic: '', internalId: null })]),
    });
    const pick = (_n: number) => 0;
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), fakeContractLookup(), undefined, undefined, undefined, undefined, undefined, pick);

    const err = await uc.execute('cust-1', minInput()).catch(e => e);
    expect(err).toBeInstanceOf(NoCicAvailableError);
    expect(err).not.toBeInstanceOf(TvPoolPoisonedError);
    expect(port.register).not.toHaveBeenCalled();
  });

  it('W2: pick devuelve índice fuera de rango (pool.length) → NoCicAvailableError, no TypeError', async () => {
    // Ambas entradas deben ser LIMPIAS (internalId: null): con el anti-poison de B1, el `pick`
    // indexa sobre el subconjunto `clean`, no sobre el pool crudo — si no fueran limpias, el pool
    // ya sería TODO envenenado y el test dejaría de ejercitar el guard de índice fuera de rango.
    const pool = [fakeAccount({ cic: 'X1', internalId: null }), fakeAccount({ cic: 'X2', internalId: null })];
    const port = fakePort({
      listAccounts: jest.fn(async () => pool),
    });
    const pick = (n: number) => n;
    const uc = new RegisterGigaredAccount(port, fakeCustomerLookup(), fakeContractLookup(), undefined, undefined, undefined, undefined, undefined, pick);

    await expect(uc.execute('cust-1', minInput()))
      .rejects.toBeInstanceOf(NoCicAvailableError);

    expect(port.register).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B1 — D-pool: anti-envenenamiento del pool (fix #1, la causa raíz confirmada,
// engram `gigared/root-cause-cic-envenenado`) + verificación post-stamp.
// ---------------------------------------------------------------------------

describe('RegisterGigaredAccount — B1 D-pool: anti-envenenamiento del pool', () => {
  it('pool mixto (1 envenenado + 1 limpio) → usa el limpio, NUNCA el envenenado', async () => {
    const poisoned = fakeAccount({ cic: 'A', internalId: 'ca4023a2' }); // dueño viejo, residuo de renewCic
    const clean = fakeAccount({ cic: 'B', internalId: null });
    const port = fakePort({
      listAccounts: jest.fn(async () => [poisoned, clean]),
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: 'B' })),
    });
    const uc = new RegisterGigaredAccount(
      port, fakeCustomerLookup(), fakeContractLookup(),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    const result = await uc.execute('cust-1', minInput());

    expect(port.register).toHaveBeenCalledWith(expect.objectContaining({ cic: 'B' }));
    expect(port.register).not.toHaveBeenCalledWith(expect.objectContaining({ cic: 'A' }));
    expect(port.activate).toHaveBeenCalledWith(expect.objectContaining({ cic: 'B' }));
    expect(port.setInternalId).toHaveBeenCalledWith('B', expect.any(String));
    expect(result.account.cic).toBe('B');
  });

  it('pool TODO envenenado → TvPoolPoisonedError, CERO writes al partner', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        fakeAccount({ cic: 'A', internalId: 'foreign-1' }),
        fakeAccount({ cic: 'B', internalId: 'foreign-2' }),
      ]),
    });
    const uc = new RegisterGigaredAccount(
      port, fakeCustomerLookup(), fakeContractLookup(),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    const err = await uc.execute('cust-1', minInput()).catch(e => e);

    expect(err).toBeInstanceOf(TvPoolPoisonedError);
    expect((err as TvPoolPoisonedError).code).toBe('TV_POOL_POISONED');
    expect(port.register).toHaveBeenCalledTimes(0);
    expect(port.activate).toHaveBeenCalledTimes(0);
    expect(port.setInternalId).toHaveBeenCalledTimes(0);
  });

  it('post-stamp mismatch: el readback tras setInternalId resuelve OTRO cic → TvIdentityStampUnverifiedError, sin fila local', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    const cat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (csRepo as any).catalog[cat.id] = { name: cat.name, label: cat.label };

    const port = fakePort({
      listAccounts: jest.fn(async () => [fakeAccount({ cic: 'CLEAN1', internalId: null })]),
      // El readback resuelve a un CIC DISTINTO del que se acaba de estampar (append-only:
      // el internal_id ya resolvía al dueño histórico). probeMissThenFound: el PROBE (1ra
      // llamada) 404ea igual — lo que importa acá es el readback POST-STAMP (2da llamada).
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: 'OTRO-CIC' })),
    });
    const uc = new RegisterGigaredAccount(
      port, fakeCustomerLookup(), fakeContractLookup(), csRepo, catalog,
      undefined, undefined, undefined, pickFirst,
    );

    const err = await uc.execute('cust-1', minInput('contract-1')).catch(e => e);

    expect(err).toBeInstanceOf(TvIdentityStampUnverifiedError);
    expect((err as TvIdentityStampUnverifiedError).code).toBe('TV_IDENTITY_UNVERIFIED');
    const tvId = (await catalog.getByName('TV'))!.id;
    expect(await csRepo.getByPair('contract-1', tvId)).toBeNull();
  });

  // F3 (INVERSIÓN JUSTIFICADA) — antes este readback-404 post-stamp salía como GigaredNotFoundError
  // (404 permanente, "not found", que invitaba a reenviar y componía con el doble registro de F1).
  // El readback post-stamp está DENTRO del try ahora: un 404 acá = identidad SIN CONFIRMAR (el stamp
  // pudo persistir con lag de replicación), la MISMA condición que un cic mismatch →
  // TvIdentityStampUnverifiedError (503, retriable). El retry se auto-completa vía probe (F1/F2).
  it('F3: post-stamp 404: el readback lanza GigaredNotFoundError → TvIdentityStampUnverifiedError (503), sin fila local', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    const cat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (csRepo as any).catalog[cat.id] = { name: cat.name, label: cat.label };

    const port = fakePort({
      listAccounts: jest.fn(async () => [fakeAccount({ cic: 'CLEAN2', internalId: null })]),
      getAccountByInternalId: jest.fn(async () => { throw new GigaredNotFoundError(); }),
    });
    const uc = new RegisterGigaredAccount(
      port, fakeCustomerLookup(), fakeContractLookup(), csRepo, catalog,
      undefined, undefined, undefined, pickFirst,
    );

    const err = await uc.execute('cust-1', minInput('contract-1')).catch(e => e);
    expect(err).toBeInstanceOf(TvIdentityStampUnverifiedError);
    expect((err as TvIdentityStampUnverifiedError).code).toBe('TV_IDENTITY_UNVERIFIED');

    const tvId = (await catalog.getByName('TV'))!.id;
    expect(await csRepo.getByPair('contract-1', tvId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B2 — D2: recovery/probe idempotente (sin unlink) + TvEmailOwnedByOtherError.
// Orden de guardas PINNED: probe -> pool-filter (B1) -> register-path -> post-stamp verify (B1)
// -> catch por instancia (GigaredRejectedError) -> discriminador por email -> 3 ramas + rethrow.
// ---------------------------------------------------------------------------

describe('RegisterGigaredAccount — B2 D2: recovery/probe idempotente', () => {
  it('mine-stamped: el probe encuentra MI internalId → skip pool/register/activate/setInternalId, solo reconcile local; recovered:true', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    const cat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (csRepo as any).catalog[cat.id] = { name: cat.name, label: cat.label };

    const myInternalId = currentTvInternalId('cust-1', 0);
    const stamped = fakeAccount({ cic: 'STAMPED1', internalId: myInternalId });
    const port = fakePort({
      getAccountByInternalId: jest.fn(async () => stamped), // el probe la encuentra de entrada
    });
    const uc = new RegisterGigaredAccount(
      port, fakeCustomerLookup(), fakeContractLookup(), csRepo, catalog,
      undefined, undefined, undefined, pickFirst,
    );

    const result = await uc.execute('cust-1', minInput('contract-1'));

    expect(port.listAccounts).not.toHaveBeenCalled(); // el pool NUNCA se consulta
    expect(port.register).toHaveBeenCalledTimes(0);
    expect(port.activate).toHaveBeenCalledTimes(0);
    expect(port.setInternalId).toHaveBeenCalledTimes(0);
    expect(result.recovered).toBe(true);
    expect(result.account.cic).toBe('STAMPED1');
  });

  it('F2: el probe resuelve una cuenta con internalId AJENO → NO confía, registra normal en el CIC limpio (recovered:false)', async () => {
    // F2 — con alias append-only, getAccountByInternalId(MI-id) puede resolver a un CIC que HOY es de
    // OTRO cliente (post-transfer). El probe SÓLO debe reanclar si probed.internalId === el MÍO; si no,
    // NO es mía → seguir el flujo normal (pool), nunca reconciliar sobre una cuenta ajena.
    const myInternalId = currentTvInternalId('cust-1', 0);
    const alien = fakeAccount({ cic: 'ALIEN-CIC', internalId: 'cust-OTHER' }); // hoy es de B (post-transfer)
    const register = jest.fn(async () => {});
    const port = fakePort({
      listAccounts: jest.fn(async () => [fakeAccount({ cic: 'CLEAN-F2', internalId: null })]),
      register,
      getAccountByInternalId: jest.fn()
        // 1ra llamada (el PROBE) resuelve una cuenta AJENA → NO es mía.
        .mockResolvedValueOnce(alien)
        // 2da (readback post-stamp) resuelve MI cuenta recién estampada en el CIC limpio.
        .mockResolvedValue(fakeAccount({ cic: 'CLEAN-F2', internalId: myInternalId })),
    });
    const uc = new RegisterGigaredAccount(
      port, fakeCustomerLookup(), fakeContractLookup(),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    const result = await uc.execute('cust-1', minInput());

    expect(result.recovered).toBe(false);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ cic: 'CLEAN-F2' }));
    expect(port.setInternalId).toHaveBeenCalledWith('CLEAN-F2', myInternalId);
    expect(result.account.cic).toBe('CLEAN-F2');
    expect(result.account.cic).not.toBe('ALIEN-CIC');
  });

  it('404 happy path: el probe no encuentra nada → sigue al pool-pick (B1), secuencia completa una vez cada uno; recovered:false', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [fakeAccount({ cic: 'FRESH1', internalId: null })]),
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: 'FRESH1' })),
    });
    const uc = new RegisterGigaredAccount(
      port, fakeCustomerLookup(), fakeContractLookup(),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    const result = await uc.execute('cust-1', minInput());

    expect(port.register).toHaveBeenCalledTimes(1);
    expect(port.activate).toHaveBeenCalledTimes(1);
    expect(port.setInternalId).toHaveBeenCalledTimes(1);
    expect(port.getAccountByInternalId).toHaveBeenCalledTimes(2); // probe + post-stamp readback
    expect(result.recovered).toBe(false);
  });

  it('orphan MÍA (email dup, CIC limpio): register rechaza, listAccounts({email}) matchea con internalId vacío → reanuda activate+setInternalId SIN re-registrar; recovered:true', async () => {
    const orphanCic = 'ORPHAN1';
    const orphanMatch = fakeAccount({ cic: orphanCic, internalId: '' });
    const register = jest.fn(async () => { throw new GigaredRejectedError('Conflict', 'email already in use'); });
    const listAccounts = jest.fn(async (filter?: { status?: string; email?: string }) => {
      if (filter?.email) return [orphanMatch];
      return [fakeAccount({ cic: 'POOLCIC', internalId: null })];
    });
    const port = fakePort({
      listAccounts, register,
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: orphanCic })),
    });
    const uc = new RegisterGigaredAccount(
      port, fakeCustomerLookup(), fakeContractLookup(),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    const result = await uc.execute('cust-1', minInput());

    expect(register).toHaveBeenCalledTimes(1); // NUNCA re-llamado
    expect(port.activate).toHaveBeenCalledWith(expect.objectContaining({ cic: orphanCic }));
    expect(port.setInternalId).toHaveBeenCalledWith(orphanCic, expect.any(String));
    expect(result.recovered).toBe(true);
  });

  it('MÍA vía email (ya estampada): register rechaza, listAccounts({email}) matchea con MI internalId → solo reconcile local, setInternalId NUNCA se llama', async () => {
    const myInternalId = currentTvInternalId('cust-1', 0);
    const mineMatch = fakeAccount({ cic: 'MINE1', internalId: myInternalId });
    const register = jest.fn(async () => { throw new GigaredRejectedError('Conflict', 'email already in use'); });
    const setInternalId = jest.fn(async () => {});
    const listAccounts = jest.fn(async (filter?: { status?: string; email?: string }) => {
      if (filter?.email) return [mineMatch];
      return [fakeAccount({ cic: 'POOLCIC', internalId: null })];
    });
    const port = fakePort({
      listAccounts, register, setInternalId,
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: 'MINE1' })),
    });
    const uc = new RegisterGigaredAccount(
      port, fakeCustomerLookup(), fakeContractLookup(),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    const result = await uc.execute('cust-1', minInput());

    expect(setInternalId).not.toHaveBeenCalled();
    expect(result.recovered).toBe(true);
    expect(result.account.cic).toBe('MINE1');
  });

  it('AJENA (email pertenece a OTRO / huérfano histórico envenenado): register rechaza, listAccounts({email}) matchea con internalId de otro → TvEmailOwnedByOtherError, setInternalId NUNCA, cero reconcile local', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    const cat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (csRepo as any).catalog[cat.id] = { name: cat.name, label: cat.label };

    const otherMatch = fakeAccount({ cic: 'OTHER1', internalId: 'cust-OTHER' });
    const register = jest.fn(async () => { throw new GigaredRejectedError('Conflict', 'email already in use'); });
    const setInternalId = jest.fn(async () => {});
    const listAccounts = jest.fn(async (filter?: { status?: string; email?: string }) => {
      if (filter?.email) return [otherMatch];
      return [fakeAccount({ cic: 'POOLCIC', internalId: null })];
    });
    const port = fakePort({ listAccounts, register, setInternalId });
    const uc = new RegisterGigaredAccount(
      port, fakeCustomerLookup(), fakeContractLookup(), csRepo, catalog,
      undefined, undefined, undefined, pickFirst,
    );

    const err = await uc.execute('cust-1', minInput('contract-1')).catch(e => e);

    expect(err).toBeInstanceOf(TvEmailOwnedByOtherError);
    expect((err as TvEmailOwnedByOtherError).code).toBe('TV_EMAIL_OWNED_BY_OTHER');
    expect(setInternalId).not.toHaveBeenCalled();
    const tvId = (await catalog.getByName('TV'))!.id;
    expect(await csRepo.getByPair('contract-1', tvId)).toBeNull();
  });

  it('sin match por email (no recuperable) → re-lanza el GigaredRejectedError ORIGINAL tal cual', async () => {
    const originalErr = new GigaredRejectedError('Conflict', 'email already in use');
    const register = jest.fn(async () => { throw originalErr; });
    const listAccounts = jest.fn(async (filter?: { status?: string; email?: string }) => {
      if (filter?.email) return [];
      return [fakeAccount({ cic: 'POOLCIC', internalId: null })];
    });
    const port = fakePort({ listAccounts, register });
    const uc = new RegisterGigaredAccount(
      port, fakeCustomerLookup(), fakeContractLookup(),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    const err = await uc.execute('cust-1', minInput()).catch(e => e);
    expect(err).toBe(originalErr); // el MISMO objeto, no uno nuevo
  });

  it('error de infra (GigaredUnavailableError, NO GigaredRejectedError) en register → propaga directo, listAccounts({email}) NUNCA se llama', async () => {
    const listAccounts = jest.fn(async (filter?: { status?: string; email?: string }) => {
      if (filter?.email) return [fakeAccount({ internalId: '' })]; // trampa: si esto se llama, hay un bug
      return [fakeAccount({ cic: 'POOLCIC', internalId: null })];
    });
    const register = jest.fn(async () => { throw new GigaredUnavailableError(); });
    const port = fakePort({ listAccounts, register });
    const uc = new RegisterGigaredAccount(
      port, fakeCustomerLookup(), fakeContractLookup(),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    await expect(uc.execute('cust-1', minInput())).rejects.toBeInstanceOf(GigaredUnavailableError);
    expect(listAccounts).toHaveBeenCalledTimes(1); // SOLO la del pool-pick, jamás la de {email}
  });

  it('idempotencia end-to-end (seq=0, ya estampada): 2do execute() → 0 llamadas nuevas a register/activate/setInternalId, 0 consumo del pool', async () => {
    const myInternalId = currentTvInternalId('cust-1', 0);
    const stamped = fakeAccount({ cic: 'IDEMP1', internalId: myInternalId });
    const listAccounts = jest.fn(async () => [fakeAccount({ cic: 'POOLCIC', internalId: null })]);
    const port = fakePort({
      listAccounts,
      getAccountByInternalId: jest.fn(async () => stamped), // SIEMPRE la encuentra (ya estampada)
    });
    const uc = new RegisterGigaredAccount(
      port, fakeCustomerLookup(), fakeContractLookup(),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    await uc.execute('cust-1', minInput());
    await uc.execute('cust-1', minInput()); // 2do, idéntico — mismo fake port, contador acumulado

    expect(port.register).toHaveBeenCalledTimes(0);
    expect(port.activate).toHaveBeenCalledTimes(0);
    expect(port.setInternalId).toHaveBeenCalledTimes(0);
    expect(listAccounts).not.toHaveBeenCalled(); // 0 consumo del pool en NINGUNA de las 2 corridas
  });
});

// ---------------------------------------------------------------------------
// F1 — re-alta idempotente con acuñado DIFERIDO del seq (fix del DOBLE REGISTRO / doble cobro).
// El seq persistido SÓLO avanza tras identidad verificada en el partner; un retry recomputa el
// MISMO candidato (getSeq()+1) y converge vía probe en vez de mintear una identidad fresca que
// re-registraría. Requiere los repos de activation + cancellation inyectados.
// ---------------------------------------------------------------------------

describe('RegisterGigaredAccount — F1: re-alta idempotente, seq diferido', () => {
  it('F1(a): re-alta, verify falla DESPUÉS del stamp → retry reancla vía probe, CERO segundo register, seq persiste al final', async () => {
    const { port, register } = statefulRealtaPort({ poolCic: 'POOL-F1A', readbackFailsOnce: true });
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1'); // re-alta: el cliente venía de baja
    const activation = new InMemoryClientTvActivationRepository();
    const uc = new RegisterGigaredAccount(
      port, fakeCustomerLookup(), fakeContractLookup(),
      undefined, undefined, tvCancellation, activation, undefined, pickFirst,
    );

    // intento 1: register + stamp corren, pero el readback post-stamp 404ea transitorio → 503.
    const err = await uc.execute('cust-1', minInput('contract-1')).catch(e => e);
    expect(err).toBeInstanceOf(TvIdentityStampUnverifiedError);
    expect(register).toHaveBeenCalledTimes(1);
    // El seq NO se persistió: la identidad no quedó confirmada. El candidato del retry será el MISMO.
    expect(await activation.getSeq('cust-1')).toBe(0);

    // intento 2 (retry): el probe recomputa el MISMO candidato y encuentra la cuenta ya estampada.
    const result = await uc.execute('cust-1', minInput('contract-1'));
    expect(register).toHaveBeenCalledTimes(1); // ← el fix: NO hay segundo register (antes: 2 = doble cobro)
    expect(result.recovered).toBe(true);
    expect(result.account.cic).toBe('POOL-F1A');
    // El seq recién se acuña ahora, tras verify OK.
    expect(await activation.getSeq('cust-1')).toBe(1);
  });

  it('F1(b) idempotencia e2e (reescrito, repos inyectados): clearCancelled falla → el seq NO avanza → retry converge, CERO segundo register', async () => {
    // Reescribe el viejo test que MENTÍA (sin repos de activation → seq=0 trivial). Pin del ORDEN
    // load-bearing (clearCancelled ANTES de persistir el seq): si el clear del flag falla (best-effort),
    // el seq NO se persiste → el retry recomputa el MISMO candidato y reancla vía probe, en vez de
    // mintear una identidad fresca que re-registraría al partner (doble cobro).
    const { port, register, listAccounts } = statefulRealtaPort({ poolCic: 'POOL-F1B' });
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1');
    // clearCancelled SIEMPRE falla (best-effort): el flag queda seteado y el seq NO debe avanzar.
    jest.spyOn(tvCancellation, 'clearCancelled').mockRejectedValue(new Error('clear flaky'));
    const activation = new InMemoryClientTvActivationRepository();
    const uc = new RegisterGigaredAccount(
      port, fakeCustomerLookup(), fakeContractLookup(),
      undefined, undefined, tvCancellation, activation, undefined, pickFirst,
    );

    // 1er execute: re-alta completa (register real), verify OK. clearCancelled falla → seq NO persiste.
    const r1 = await uc.execute('cust-1', minInput('contract-1'));
    expect(register).toHaveBeenCalledTimes(1);
    expect(r1.recovered).toBe(false);
    expect(await activation.getSeq('cust-1')).toBe(0); // clear falló → seq NO avanzó (sin drift)

    // 2do execute (retry): candidato = getSeq()+1 = 1 (MISMO) → el probe encuentra la ya estampada.
    const r2 = await uc.execute('cust-1', minInput('contract-1'));
    expect(register).toHaveBeenCalledTimes(1); // ← CERO segundo register (converge, no doble cobro)
    expect(r2.recovered).toBe(true);
    expect(r2.account.cic).toBe('POOL-F1B');
    expect(listAccounts).toHaveBeenCalledTimes(1); // el pool sólo se consumió en el 1er intento
  });
});

// ---------------------------------------------------------------------------
// #115 — Nueva conducta: identidad deriva del grContratoId (NO del grClienteId)
// ---------------------------------------------------------------------------

describe('RegisterGigaredAccount #115 — identidad TV deriva del grContratoId del contrato', () => {

  it('alta primera vez: password derivada de grContratoId (NO de grClienteId)', async () => {
    // Cliente con grClienteId='999999'; contrato con grContratoId='204382'
    // → password debe ser deterministicTvPassword('204382'), no 'ip999999'
    const register = jest.fn(async () => {});
    const port = fakePort({
      listAccounts: poolOf('CIC01'),
      register,
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: 'CIC01' })),
    });
    const uc = new RegisterGigaredAccount(
      port,
      fakeCustomerLookup(true, '999999'),
      fakeContractLookup({ grContratoId: '204382' }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    await uc.execute('cust-1', minInput('contract-1'));

    const callArg = (register.mock.calls[0] as unknown[])[0] as { password: string };
    expect(callArg.password).toBe(deterministicTvPassword('204382'));
    // Asegurar que NO se usó el grClienteId del cliente
    expect(callArg.password).not.toBe(deterministicTvPassword('999999'));
  });

  it('re-alta (seq=1): email deriva de grContratoId, no de grClienteId', async () => {
    const { InMemoryClientTvCancellationRepository } = await import(
      '@infrastructure/adapters/in-memory/InMemoryClientTvCancellationRepository'
    );
    const { InMemoryClientTvActivationRepository } = await import(
      '@infrastructure/adapters/in-memory/InMemoryClientTvActivationRepository'
    );
    const register = jest.fn(async () => {});
    const port = fakePort({
      listAccounts: poolOf('CIC02'),
      register,
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: 'CIC02' })),
    });

    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1');
    const activation = new InMemoryClientTvActivationRepository();

    const uc = new RegisterGigaredAccount(
      port,
      // B8 (D1): el email deriva de customer.name (split), NO de input.lastName — el name acá
      // trae 'López' como primer token para que la aserción de email siga siendo válida.
      fakeCustomerLookup(true, '999999', 'López Ana'),
      fakeContractLookup({ grContratoId: '204382' }),
      undefined, undefined,
      tvCancellation,
      activation,
      undefined, pickFirst,
    );

    await uc.execute('cust-1', { ...minInput('contract-1'), lastName: 'López' });

    const callArg = (register.mock.calls[0] as unknown[])[0] as { email: string };
    // seq=1 → email = deterministicTvEmail('López', '204382', 1) — 'López' ahora viene del
    // customer.name resuelto (split D1), no del input.
    expect(callArg.email).toBe(deterministicTvEmail('López', '204382', 1));
    // NO el derivado del grClienteId
    expect(callArg.email).not.toBe(deterministicTvEmail('López', '999999', 1));
  });

  it('contrato sin grContratoId (null) → GrContractIdRequiredError, Gigared no tocado', async () => {
    const port = fakePort({ listAccounts: poolOf('CIC03') });
    const uc = new RegisterGigaredAccount(
      port,
      fakeCustomerLookup(),
      fakeContractLookup({ grContratoId: null }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    const err = await uc.execute('cust-1', minInput()).catch(e => e);

    expect(err).toBeInstanceOf(GrContractIdRequiredError);
    expect((err as GrContractIdRequiredError).code).toBe('GR_CONTRACT_ID_REQUIRED');
    expect(port.register).not.toHaveBeenCalled();
    expect(port.activate).not.toHaveBeenCalled();
    expect(port.setInternalId).not.toHaveBeenCalled();
  });

  it('grContratoId con chars fuera de CUA → GrContractIdRequiredError, Gigared no tocado', async () => {
    // 'GR-ABCD' genera 'ipGR-ABCD' que tiene guión y mayúsculas → fuera de [a-z0-9]
    const port = fakePort({ listAccounts: poolOf('CIC04') });
    const uc = new RegisterGigaredAccount(
      port,
      fakeCustomerLookup(),
      fakeContractLookup({ grContratoId: 'GR-ABCD' }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    const err = await uc.execute('cust-1', minInput()).catch(e => e);

    expect(err).toBeInstanceOf(GrContractIdRequiredError);
    expect((err as GrContractIdRequiredError).code).toBe('GR_CONTRACT_ID_REQUIRED');
    expect(port.register).not.toHaveBeenCalled();
  });

  it('contrato ajeno (clientId != customerId) → ContractNotFoundError, Gigared no tocado (validación SIEMPRE)', async () => {
    const port = fakePort({ listAccounts: poolOf('CIC05') });
    const uc = new RegisterGigaredAccount(
      port,
      fakeCustomerLookup(),
      fakeContractLookup({ clientId: 'otro-cliente', grContratoId: '204382' }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    const err = await uc.execute('cust-1', minInput()).catch(e => e);

    expect(err).toBeInstanceOf(ContractNotFoundError);
    expect(port.register).not.toHaveBeenCalled();
    expect(port.activate).not.toHaveBeenCalled();
  });

  it('internal_id sigue siendo currentTvInternalId(customerId, seq) — NO cambia', async () => {
    const setInternalId = jest.fn(async () => {});
    const port = fakePort({
      listAccounts: poolOf('CIC06'),
      setInternalId,
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: 'CIC06' })),
    });
    const uc = new RegisterGigaredAccount(
      port,
      fakeCustomerLookup(true, '999999'),
      fakeContractLookup({ grContratoId: '204382' }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    await uc.execute('cust-1', minInput('contract-1'));

    // seq=0 (primera alta, sin repos de activation/cancellation) → internal_id = 'cust-1'
    expect(setInternalId).toHaveBeenCalledWith('CIC06', currentTvInternalId('cust-1', 0));
  });
});

// ---------------------------------------------------------------------------
// #118 — Alta nueva (seq=0): email debe derivar server-side del grContratoId
//         igual que la clave y que la re-alta — no del input.email del FE
// ---------------------------------------------------------------------------

describe('RegisterGigaredAccount #118 — alta nueva (seq=0): email server-side del grContratoId', () => {

  it('alta nueva (seq=0): email enviado a Gigared = deterministicTvEmail(lastName, grContratoId, 0), NO input.email del FE', async () => {
    // El FE manda un input.email derivado del grClienteId (ej: 'perez999999@gmail.com')
    // El server debe ignorarlo y derivar el email del grContratoId='204382' server-side
    const register = jest.fn(async () => {});
    const port = fakePort({
      listAccounts: poolOf('CIC10'),
      register,
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: 'CIC10' })),
    });
    const uc = new RegisterGigaredAccount(
      port,
      // B8 (D1): 'Pérez' ahora entra vía customer.name (split), no vía input.lastName.
      fakeCustomerLookup(true, '999999', 'Pérez Juan'),
      fakeContractLookup({ grContratoId: '204382' }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    // input.email simula lo que manda el FE (derivado del grClienteId, NO del grContratoId)
    const inputEmailFromFe = 'perez999999@gmail.com';
    await uc.execute('cust-1', { ...minInput('contract-1'), lastName: 'Pérez', email: inputEmailFromFe });

    const callArg = (register.mock.calls[0] as unknown[])[0] as { email: string };
    // Debe ser el email server-side derivado del grContratoId, seq=0
    expect(callArg.email).toBe(deterministicTvEmail('Pérez', '204382', 0));
    // NO el email del FE (que viene del grClienteId)
    expect(callArg.email).not.toBe(inputEmailFromFe);
  });

  it('#118: email (seq=0) y password derivan del MISMO grContratoId — fuente única', async () => {
    // Ambos deben venir de '204382', no de '999999' (grClienteId)
    const register = jest.fn(async () => {});
    const port = fakePort({
      listAccounts: poolOf('CIC11'),
      register,
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: 'CIC11' })),
    });
    const uc = new RegisterGigaredAccount(
      port,
      // B8 (D1): 'García' ahora entra vía customer.name (split), no vía input.lastName.
      fakeCustomerLookup(true, '999999', 'García Luis'),
      fakeContractLookup({ grContratoId: '204382' }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    await uc.execute('cust-1', { ...minInput('contract-1'), lastName: 'García' });

    const callArg = (register.mock.calls[0] as unknown[])[0] as { email: string; password: string };
    expect(callArg.email).toBe(deterministicTvEmail('García', '204382', 0));
    expect(callArg.password).toBe(deterministicTvPassword('204382'));
    // Confirmar que NINGUNO deriva del grClienteId
    expect(callArg.email).not.toContain('999999');
    expect(callArg.password).not.toContain('999999');
  });
});

// ---------------------------------------------------------------------------
// B8 (D1, OPCIONAL hardening) — nombre BE-authoritative: el register deriva firstName/lastName
// del customer resuelto (split APELLIDO-primero), NUNCA del body. Forensics probó que el body-name
// NO fue el vector del incidente — este batch cierra un vector TEÓRICO, no el confirmado.
// ---------------------------------------------------------------------------

describe('RegisterGigaredAccount — B8 (D1, OPCIONAL): nombre BE-authoritative', () => {
  it('body con nombre AJENO → la cuenta se crea con el nombre del CLIENTE (split), NUNCA con el del input', async () => {
    const register = jest.fn(async () => {});
    const port = fakePort({
      listAccounts: poolOf('CICB8-1'),
      register,
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: 'CICB8-1' })),
    });
    const uc = new RegisterGigaredAccount(
      port,
      // El customer resuelto es CENTENO MIGUEL ANGEL — el input trae otra persona.
      fakeCustomerLookup(true, '999999', 'CENTENO MIGUEL ANGEL'),
      fakeContractLookup({ grContratoId: '204382' }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    await uc.execute('cust-1', {
      ...minInput('contract-1'),
      firstName: 'VACHERAND',
      lastName: 'SILVIO GABRIEL',
    });

    const callArg = (register.mock.calls[0] as unknown[])[0] as { firstName: string; lastName: string };
    expect(callArg).toEqual(
      expect.objectContaining({ firstName: 'MIGUEL ANGEL', lastName: 'CENTENO' }),
    );
    expect(callArg.firstName).not.toBe('VACHERAND');
    expect(callArg.lastName).not.toBe('SILVIO GABRIEL');
  });

  it('deterministicTvEmail se invoca con el lastName DERIVADO del customer, no el del input', async () => {
    const register = jest.fn(async () => {});
    const port = fakePort({
      listAccounts: poolOf('CICB8-2'),
      register,
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: 'CICB8-2' })),
    });
    const uc = new RegisterGigaredAccount(
      port,
      fakeCustomerLookup(true, '999999', 'CENTENO MIGUEL ANGEL'),
      fakeContractLookup({ grContratoId: '204382' }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    await uc.execute('cust-1', {
      ...minInput('contract-1'),
      firstName: 'VACHERAND',
      lastName: 'SILVIO GABRIEL',
    });

    const callArg = (register.mock.calls[0] as unknown[])[0] as { email: string };
    // email deriva de deterministicTvEmail('CENTENO', grContratoId, seq=0) — el apellido del
    // CUSTOMER, NUNCA 'SILVIO GABRIEL' (el lastName del input, que además ni siquiera es un
    // apellido válido en la convención APELLIDO-primero).
    expect(callArg.email).toBe(deterministicTvEmail('CENTENO', '204382', 0));
  });

  it('customer.name con 1 solo token → firstName=lastName; register recibe eso', async () => {
    const register = jest.fn(async () => {});
    const port = fakePort({
      listAccounts: poolOf('CICB8-3'),
      register,
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: 'CICB8-3' })),
    });
    const uc = new RegisterGigaredAccount(
      port,
      fakeCustomerLookup(true, '999999', 'MADONNA'),
      fakeContractLookup({ grContratoId: '204382' }),
      undefined, undefined, undefined, undefined, undefined, pickFirst,
    );

    await uc.execute('cust-1', minInput('contract-1'));

    const callArg = (register.mock.calls[0] as unknown[])[0] as { firstName: string; lastName: string };
    expect(callArg).toEqual(expect.objectContaining({ firstName: 'MADONNA', lastName: 'MADONNA' }));
  });
});
