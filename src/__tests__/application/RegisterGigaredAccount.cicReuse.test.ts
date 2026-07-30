/**
 * gigared-tv-cic-reuse (Fase 4) — reutilización de CICs reciclados + reintento acotado.
 *
 * CONTEXTO DEL BUG (2026-07-30): NINGUNA alta de TV funcionaba. El pool `unregistered` tenía
 * 10 cuentas: 9 con el `internal_id` de un cliente nuestro (residuo del `renewCic` de la baja,
 * que es append-only y no se puede limpiar) y 1 sin identidad pero con el CIC CORRUPTO
 * (`'00065470 4'`, byte 0x20). El filtro B1 validaba presencia del cic pero no su FORMATO, así
 * que el corrupto pasaba como "limpio"; con UN solo candidato el pick aleatorio es
 * determinístico, así que se elegía SIEMPRE; el partner respondía 403 `cic-ownership-error`;
 * el adapter lo mapea a NotFound; y el `catch` del register sólo contemplaba
 * `GigaredRejectedError`, así que salía un 404 "Gigared account not found" CRUDO al operador.
 *
 * Este archivo fija el comportamiento nuevo. Los tests preexistentes de
 * `RegisterGigaredAccount.usecase.test.ts` deben seguir verdes SIN editarlos (T4.8).
 */
import { RegisterGigaredAccount } from '@application/use-cases/gigared/RegisterGigaredAccount';
import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import {
  TvPoolPoisonedError,
  TvPoolUnavailableError,
  TvNoUsableCicError,
  GigaredNotFoundError,
  GigaredRejectedError,
  GigaredUnavailableError,
} from '@domain/errors/gigared';
import { InMemoryTvCicReuseEligibilityRepository } from '@infrastructure/adapters/in-memory/InMemoryTvCicReuseEligibilityRepository';

// --- Identidades reales del pool de producción del 2026-07-30 ---
const GUILLEN = 'bb25d17b-4770-48e3-9686-d9d9929e1898'; // baja 08/07 → elegible
const MALLORQUIN = '7d4e3ec6-34b0-440c-b7c2-6f263f3e6f8f'; // baja 22/07 (seq 1) → elegible
const ALVEZ = '3ef5eb6e-bc75-41a5-b816-8336c739497b'; // SIN baja local → NO elegible
const PAVIOLO = 'd888bea2-7833-494b-b3a6-b246284ef4e9'; // baja 10/07 → elegible

/** El cliente NUEVO que recibe el alta. */
const NUEVO = '11111111-2222-3333-4444-555555555555';
const CIC_ROTO = '00065470 4';

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  return {
    cic: '0006677401', gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '2026-01-19', services: [], internalId: NUEVO, clientId: NUEVO, ott: null,
    ...over,
  };
}

/** El probe idempotente 404ea (nada estampado todavía); el readback post-stamp resuelve. */
function probeMissThenFound(final: GigaredAccount = fakeAccount()): jest.Mock {
  return jest.fn().mockRejectedValueOnce(new GigaredNotFoundError()).mockResolvedValue(final);
}

/**
 * RONDA 3 — entrada REAL del listado del pool. Las 10 cuentas verificadas contra el partner el
 * 2026-07-30 traen `email`/`firstName`/`lastName`/`registrationDate` en **null explícito**, y
 * eso es justo lo que el guard mira ahora (sin llamada extra: el dato ya viene en el listado).
 * Un literal `{cic, internalId}` pelado deja esos campos en `undefined` = shape desconocido.
 */
function poolEntry(cic: string, internalId: string | null): GigaredAccount {
  return fakeAccount({ cic, internalId, email: null, firstName: null, lastName: null, registrationDate: null });
}

function fakePort(over: Partial<GigaredPort> = {}): GigaredPort {
  return {
    getSummary: jest.fn(),
    listAccounts: jest.fn(async () => []),
    getAccountByInternalId: probeMissThenFound(),
    // FIX WAVE F4 — por defecto, una cuenta del POOL: REALMENTE libre (email/nombre/fecha en
    // null, como las 10 reales del 2026-07-30). Antes devolvía una cuenta registrada, que es
    // justo lo que el guard nuevo debe rechazar.
    // FIX WAVE 2 — el fake ECHOA el cic pedido. Antes devolvía siempre el mismo, y con la
    // prueba positiva de identidad (`cuenta.cic === cic`) eso hacía fallar la verificación de
    // cualquier candidato distinto del default: el fixture medía el fixture, no el código.
    getAccountByCic: jest.fn(async (cic: string) =>
      fakeAccount({ cic, email: null, firstName: null, lastName: null, registrationDate: null }),
    ),
    register: jest.fn(async () => {}),
    activate: jest.fn(async () => {}),
    setInternalId: jest.fn(async () => {}),
    addService: jest.fn(async () => {}),
    removeService: jest.fn(async () => {}),
    setOtt: jest.fn(async () => {}),
    changePassword: jest.fn(async () => {}),
    renewCic: jest.fn(async () => ({ oldCic: 'a', newCic: 'b' })),
    ...over,
  };
}

const customerLookup = { findById: async (id: string) => ({ id, grClienteId: '999', name: 'PEREZ JUAN' }) };
const contractLookup = { findById: async (id: string) => ({ id, clientId: NUEVO, grContratoId: '204382' }) };

/** Todos los clientes de baja del pool real, elegibles salvo ALVEZ. */
function eligibilityRepo(): InMemoryTvCicReuseEligibilityRepository {
  const r = new InMemoryTvCicReuseEligibilityRepository();
  r.seed(GUILLEN, { cancelled: true, hasActiveTvRow: false });
  r.seed(MALLORQUIN, { cancelled: true, hasActiveTvRow: false });
  r.seed(PAVIOLO, { cancelled: true, hasActiveTvRow: false });
  r.seed(ALVEZ, { cancelled: false, hasActiveTvRow: false }); // drift: sin baja local
  return r;
}

function makeUseCase(
  port: GigaredPort,
  opts: { pick?: (n: number) => number; reuse?: InMemoryTvCicReuseEligibilityRepository } = {},
) {
  return new RegisterGigaredAccount(
    port,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    customerLookup as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contractLookup as any,
    undefined, undefined, undefined, undefined, undefined,
    opts.pick ?? (() => 0),
    opts.reuse,
  );
}

const INPUT = {
  firstName: 'X', lastName: 'Y', email: 'ignored@x.com',
  sendActivationEmail: false, contractId: 'ct-1',
};


/**
 * RONDA 3 (higiene) — silenciador GLOBAL de `console.warn` con restauración por `afterEach`.
 * Antes cada test creaba su spy y lo restauraba con una línea AL FINAL del cuerpo: si una
 * aserción previa tiraba, el spy se filtraba al resto del archivo (dependencia de orden +
 * salida enmascarada). Y los tests SIN spy escupían warns reales con stack traces al suite.
 */
beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('T4.1 — el listado del pool que falla NUNCA sale como 404', () => {
  it('un GigaredNotFoundError del listado → TvPoolUnavailableError (503), no un 404 crudo', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => { throw new GigaredNotFoundError(); }),
    });
    const uc = makeUseCase(port, { reuse: eligibilityRepo() });

    await expect(uc.execute(NUEVO, INPUT)).rejects.toBeInstanceOf(TvPoolUnavailableError);
  });

  /**
   * FIX WAVE F5 — CAMBIO DE CONTRATO DELIBERADO. Este test afirmaba que un
   * `GigaredUnavailableError` del listado TAMBIÉN se convertía en `TvPoolUnavailableError`.
   * El review mostró que ese wrap indiscriminado es dañino: aplastaba `GigaredAuthError`
   * (API key vencida), `GigaredNotConfiguredError` y `GigaredRejected` en un 503 "reintentá en
   * unos segundos" — el operador reintentaría para siempre sobre algo que no se arregla solo —
   * y tiraba el `detail` RFC 9457 que #47g existe para exponer.
   *
   * ERR-1.1 sólo necesitaba tapar el NotFound (el que salía como 404 "Gigared account not
   * found"). Todo error que YA tiene su propio código de wire se propaga tal cual.
   */
  it('un error del listado que YA tiene código propio se propaga TAL CUAL (no lo aplasta)', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => { throw new GigaredUnavailableError('caído', 'timeout'); }),
    });
    const uc = makeUseCase(port, { reuse: eligibilityRepo() });

    const err = await uc.execute(NUEVO, INPUT).catch(e => e);
    expect(err).toBeInstanceOf(GigaredUnavailableError);
    expect(err).not.toBeInstanceOf(TvPoolUnavailableError);
    expect((err as GigaredUnavailableError).detail).toBe('timeout');
  });
});

describe('T4.3 — LIMPIO PRIMERO (la reutilización es el fallback, no el default)', () => {
  it('con 1 limpio y 3 reutilizables → elige el LIMPIO', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        poolEntry('0006677401', GUILLEN),
        poolEntry('0006168430', PAVIOLO),
        poolEntry('0009999999', null), // el único limpio
        poolEntry('0006450297', `${MALLORQUIN}-1`),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: '0009999999' })),
    });
    const uc = makeUseCase(port, { reuse: eligibilityRepo() });

    await uc.execute(NUEVO, INPUT);

    expect(port.register).toHaveBeenCalledTimes(1);
    expect((port.register as jest.Mock).mock.calls[0][0].cic).toBe('0009999999');
  });

  it('el CIC MALFORMADO no cuenta como limpio — se reutiliza en vez de elegirlo', async () => {
    // Reproduce el pool real: el único sin identidad es el corrupto.
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        { cic: CIC_ROTO, internalId: null },
        poolEntry('0006677401', GUILLEN),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    });
    const uc = makeUseCase(port, { reuse: eligibilityRepo() });

    await uc.execute(NUEVO, INPUT);

    const cicsUsados = (port.register as jest.Mock).mock.calls.map(c => c[0].cic);
    expect(cicsUsados).not.toContain(CIC_ROTO);
    expect(cicsUsados).toEqual(['0006677401']);
  });
});

describe('T4.4 — reutilización end-to-end', () => {
  it('pool 100% reutilizable → el alta se completa y estampa la identidad NUEVA', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        poolEntry('0006677401', GUILLEN),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    });
    const uc = makeUseCase(port, { reuse: eligibilityRepo() });

    const res = await uc.execute(NUEVO, INPUT);

    expect(res.partnerCreated).toBe(true);
    expect(port.register).toHaveBeenCalledTimes(1);
    expect(port.activate).toHaveBeenCalledTimes(1);
    // El estampado usa MI identidad, no la del dueño viejo.
    expect(port.setInternalId).toHaveBeenCalledWith('0006677401', NUEVO);
  });

  it('reutiliza también un CIC cuya identidad trae sufijo de re-alta (caso MALLORQUIN -1)', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        poolEntry('0006450297', `${MALLORQUIN}-1`),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: '0006450297' })),
    });
    const uc = makeUseCase(port, { reuse: eligibilityRepo() });

    await uc.execute(NUEVO, INPUT);
    expect((port.register as jest.Mock).mock.calls[0][0].cic).toBe('0006450297');
  });
});

describe('T4.5 — el NO elegible jamás se toca (caso ALVEZ SUSANA)', () => {
  it('cliente sin baja local → NO se reutiliza y el alta falla con TvPoolPoisonedError', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        poolEntry('0006166000', ALVEZ),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    });
    const uc = makeUseCase(port, { reuse: eligibilityRepo() });

    await expect(uc.execute(NUEVO, INPUT)).rejects.toBeInstanceOf(TvPoolPoisonedError);
    expect(port.register).not.toHaveBeenCalled();
  });

  it('cliente de baja PERO con fila de TV activa (drift) → tampoco se reutiliza', async () => {
    const reuse = eligibilityRepo();
    reuse.seed(GUILLEN, { cancelled: true, hasActiveTvRow: true });
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        poolEntry('0006677401', GUILLEN),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    });

    await expect(makeUseCase(port, { reuse }).execute(NUEVO, INPUT)).rejects.toBeInstanceOf(
      TvPoolPoisonedError,
    );
    expect(port.register).not.toHaveBeenCalled();
  });

  it('identidad NO parseable (tercero desconocido) → jamás candidato', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        poolEntry('0006677401', 'MI_CLIENTE_001'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    });

    await expect(
      makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT),
    ).rejects.toBeInstanceOf(TvPoolPoisonedError);
    expect(port.register).not.toHaveBeenCalled();
  });

  it('SIN el repo de elegibilidad cableado → NINGÚN estampado se reutiliza (degradación segura)', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        poolEntry('0006677401', GUILLEN),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    });

    await expect(makeUseCase(port).execute(NUEVO, INPUT)).rejects.toBeInstanceOf(
      TvPoolPoisonedError,
    );
    expect(port.register).not.toHaveBeenCalled();
  });
});

describe('T4.6 — reintento acotado ante un CIC inservible', () => {
  const poolDeTres = [
    poolEntry('0006677401', GUILLEN),
    poolEntry('0006168430', PAVIOLO),
    poolEntry('0006450297', `${MALLORQUIN}-1`),
  ];

  it('register 404 en el 1er candidato + 2do válido → el alta se completa, sin error al operador', async () => {
    // FIX WAVE F3 — marcado `cicNotOwned`: es el 403 `cic-ownership-error` del partner, la
    // ÚNICA respuesta que prueba que rechazó antes de crear nada.
    const register = jest.fn()
      .mockRejectedValueOnce(new GigaredNotFoundError(undefined, true))
      .mockResolvedValue(undefined);
    // El readback post-stamp sigue al cic realmente estampado (que acá NO es el primer
    // candidato, justamente porque el reintento pasó al segundo).
    let estampado = '';
    const port = fakePort({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listAccounts: jest.fn(async () => poolDeTres as any),
      register,
      setInternalId: jest.fn(async (cic: string) => { estampado = cic; }),
      getAccountByInternalId: jest.fn()
        .mockRejectedValueOnce(new GigaredNotFoundError())
        .mockImplementation(async () => fakeAccount({ cic: estampado })),
    });

    const res = await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT);

    expect(res.partnerCreated).toBe(true);
    expect(register).toHaveBeenCalledTimes(2);
    expect(port.activate).toHaveBeenCalledTimes(1);
    // El SEGUNDO candidato es el que quedó estampado, no el primero (que era inservible).
    expect(estampado).toBe('0006168430');
  });

  it('todos inservibles → TvNoUsableCicError (422), NUNCA GigaredNotFoundError', async () => {
    // FIX WAVE F3 — un "cic inservible" REAL llega como 403 `cic-ownership-error`, que el
    // adapter marca con `cicNotOwned`. Un not-found SIN esa marca es indeterminado y ya NO
    // habilita el reintento (podría haber creado la cuenta ⇒ doble cobro).
    const register = jest.fn(async () => { throw new GigaredNotFoundError(undefined, true); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const port = fakePort({ listAccounts: jest.fn(async () => poolDeTres as any), register });

    const err = await makeUseCase(port, { reuse: eligibilityRepo() })
      .execute(NUEVO, INPUT).catch(e => e);

    expect(err).toBeInstanceOf(TvNoUsableCicError);
    expect(err).not.toBeInstanceOf(GigaredNotFoundError);
  });

  it('el tope es 3: con 4 candidatos malos, register se llama EXACTAMENTE 3 veces', async () => {
    // FIX WAVE F3 — un "cic inservible" REAL llega como 403 `cic-ownership-error`, que el
    // adapter marca con `cicNotOwned`. Un not-found SIN esa marca es indeterminado y ya NO
    // habilita el reintento (podría haber creado la cuenta ⇒ doble cobro).
    const register = jest.fn(async () => { throw new GigaredNotFoundError(undefined, true); });
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        ...poolDeTres,
        poolEntry('0006871501', 'ab00f71d-2e76-4038-9510-166fc205e5e3'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
      register,
    });
    const reuse = eligibilityRepo();
    reuse.seed('ab00f71d-2e76-4038-9510-166fc205e5e3', { cancelled: true, hasActiveTvRow: false });

    await expect(makeUseCase(port, { reuse }).execute(NUEVO, INPUT)).rejects.toBeInstanceOf(
      TvNoUsableCicError,
    );
    expect(register).toHaveBeenCalledTimes(3);
  });

  it('NO reintenta con otro CIC ante un error que NO es not-found (anti doble registro)', async () => {
    const register = jest.fn(async () => { throw new GigaredUnavailableError(); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const port = fakePort({ listAccounts: jest.fn(async () => poolDeTres as any), register });

    await expect(
      makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT),
    ).rejects.toBeInstanceOf(GigaredUnavailableError);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('un fallo de `activate` NO reintenta con otro CIC (dejaría una cuenta huérfana)', async () => {
    const activate = jest.fn(async () => { throw new GigaredUnavailableError(); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const port = fakePort({ listAccounts: jest.fn(async () => poolDeTres as any), activate });

    await expect(
      makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT),
    ).rejects.toBeInstanceOf(GigaredUnavailableError);
    expect(port.register).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('el camino de GigaredRejectedError (discriminador por email) se PRESERVA', async () => {
    // No es "cic inservible": es el recovery idempotente por email del hardening previo.
    const register = jest.fn(async () => { throw new GigaredRejectedError('dup', 'Email ya utilizado'); });
    const listAccounts = jest.fn(async (filter?: { status?: string; email?: string }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (filter?.email ? [fakeAccount(poolEntry('0006677401', NUEVO))] : poolDeTres) as any,
    );
    const port = fakePort({ listAccounts, register });

    const res = await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT);

    expect(res.recovered).toBe(true);
    expect(register).toHaveBeenCalledTimes(1); // NO se reintentó con otro CIC
  });
});

describe('F4 — la cuenta se verifica con el DATO DEL LISTADO, sin llamada extra', () => {
  /**
   * La invariante LOCAL (3 condiciones) puede dar `true` sobre un cliente CON una cuenta VIVA:
   * el propio alta deja la fila de TV en `inactive`, `clearCancelled` es best-effort y puede
   * fallar, y tras una transferencia el ORIGEN queda cancelado + fila inactiva mientras el CIC
   * es del DESTINO. En los tres casos reutilizar ese CIC le roba la TV a alguien.
   *
   * RONDA 3 — la 4ta condición se resuelve con los campos que YA vienen en el listado del pool
   * (`listAccounts` y `getAccountByCic` comparten `mapAccount`), NO con un GET extra: ese GET
   * era redundante Y colgaba la premisa de un endpoint que nadie verificó para cuentas del pool.
   */
  it('entrada del pool con email/fecha SETEADOS -> NO se reutiliza (cuenta ocupada)', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        fakeAccount({ cic: '0006677401', internalId: GUILLEN, email: 'guillen@x.com', registrationDate: '2026-06-01' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    });

    const err = await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT).catch(e => e);
    expect(err).toBeInstanceOf(TvPoolPoisonedError);
    expect(port.register).not.toHaveBeenCalled();
  });

  it('entrada del pool realmente libre (los 4 campos en null) -> SI se reutiliza', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const port = fakePort({ listAccounts: jest.fn(async () => [poolEntry('0006677401', GUILLEN)] as any) });

    const res = await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT);
    expect(res.partnerCreated).toBe(true);
    expect(port.register).toHaveBeenCalledTimes(1);
  });

  it('CERO llamadas extra al partner: el dato ya venia en el listado', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const port = fakePort({ listAccounts: jest.fn(async () => [poolEntry('0006677401', GUILLEN)] as any) });

    await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT);
    expect(port.getAccountByCic).not.toHaveBeenCalled();
  });

  /**
   * FALLA CERRADO — `undefined` es DESCONOCIDO, no vacío. Si el partner cambiara el shape del
   * envelope, un predicado permisivo apagaría el guard solo, en silencio, sobre el 100% del
   * pool. Y la condición honesta es TRANSITORIA (no sabemos), no veneno (422 terminal).
   */
  it('campos AUSENTES (undefined) -> no-verificable => 503 transitorio, NO veneno', async () => {
    const port = fakePort({
      // Literal pelado: sin email/nombre/fecha => shape desconocido.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listAccounts: jest.fn(async () => [{ cic: '0006677401', internalId: GUILLEN }] as any),
    });

    const err = await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT).catch(e => e);
    expect(err).toBeInstanceOf(TvPoolUnavailableError);
    expect(err).not.toBeInstanceOf(TvPoolPoisonedError);
    expect(port.register).not.toHaveBeenCalled();
  });

  it('Postgres caido en la elegibilidad -> TRANSITORIO (503), NO "pool envenenado"', async () => {
    const reuse = eligibilityRepo();
    jest.spyOn(reuse, 'isEligibleForCicReuse').mockRejectedValue(new Error('ECONNREFUSED 5432'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const port = fakePort({ listAccounts: jest.fn(async () => [poolEntry('0006677401', GUILLEN)] as any) });

    const err = await makeUseCase(port, { reuse }).execute(NUEVO, INPUT).catch(e => e);
    expect(err).toBeInstanceOf(TvPoolUnavailableError);
    expect(err).not.toBeInstanceOf(TvPoolPoisonedError);
  });

  it('veneno REAL (no elegible) sigue dando TvPoolPoisonedError con su cuenta exacta', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        poolEntry('0006166000', ALVEZ),
        poolEntry('0006832019', 'ffffffff-0000-0000-0000-000000000000'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    });

    const err = await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT).catch(e => e);
    expect(err).toBeInstanceOf(TvPoolPoisonedError);
    expect((err as TvPoolPoisonedError).poisonedCount).toBe(2);
  });

  /**
   * RONDA 3 (M5) — la precedencia entre los DOS contadores. Antes `noVerificables > 0` ganaba
   * INCONDICIONALMENTE: UN solo fallo de verificación enmascaraba N venenos y el operador veía
   * "reintentá en unos segundos" sobre un pool que no se arregla solo. Ahora la duda gana sólo
   * si DOMINA, y los dos números viajan SIEMPRE en el mensaje.
   */
  it('M5 — 1 veneno + 1 duda (empate) -> gana lo TRANSITORIO, y el mensaje dice AMBOS', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        poolEntry('0006166000', ALVEZ),
        { cic: '0006677401', internalId: GUILLEN },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    });

    const err = await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT).catch(e => e);
    expect(err).toBeInstanceOf(TvPoolUnavailableError);
    expect((err as TvPoolUnavailableError).detail).toContain('descartado');
  });

  it('M5-bis — MUCHOS venenos + 1 duda -> gana el VENENO (la duda no puede taparlos)', async () => {
    const ajenos = [0, 1, 2, 3, 4].map(i =>
      poolEntry('000600000' + i, 'ffffffff-0000-0000-0000-00000000000' + i),
    );
    const port = fakePort({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listAccounts: jest.fn(async () => [...ajenos, { cic: '0006677401', internalId: GUILLEN }] as any),
    });

    const err = await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT).catch(e => e);
    expect(err).toBeInstanceOf(TvPoolPoisonedError);
    expect((err as TvPoolPoisonedError).poisonedCount).toBe(5);
  });

  it('con suficientes CICs LIMPIOS no se verifica ningun reutilizable', async () => {
    const reuse = eligibilityRepo();
    const spy = jest.spyOn(reuse, 'isEligibleForCicReuse');
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        poolEntry('0009999991', null), poolEntry('0009999992', null), poolEntry('0009999993', null),
        poolEntry('0006677401', GUILLEN), poolEntry('0006168430', PAVIOLO),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
      getAccountByInternalId: probeMissThenFound(fakeAccount({ cic: '0009999991' })),
    });

    await makeUseCase(port, { reuse }).execute(NUEVO, INPUT);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('T4.7 — REGRESIÓN: el pool REAL de producción del 2026-07-30', () => {
  // Las 10 cuentas exactas que tenía el partner cuando el alta estaba rota al 100%.
  const POOL_REAL = [
    poolEntry('0006677401', GUILLEN),
    poolEntry('0006168430', PAVIOLO),
    poolEntry('0006832019', '2815a6b3-e104-4c86-9d0b-bc1e45b49aca'),
    poolEntry('0006107090', 'e2772dda-bf27-4998-8482-885454e532ab'),
    poolEntry('0006411239', '6a31c2c9-56cf-4d05-87a2-96827182499a'),
    poolEntry('0006450297', `${MALLORQUIN}-1`),
    poolEntry('0006166000', ALVEZ),
    poolEntry('0006871501', 'ab00f71d-2e76-4038-9510-166fc205e5e3'),
    { cic: CIC_ROTO, internalId: null },
    poolEntry('0006282445', '97efa072-2fe1-48e4-b828-bf247533f374'),
  ];

  function repoConLos8DeBaja(): InMemoryTvCicReuseEligibilityRepository {
    const r = new InMemoryTvCicReuseEligibilityRepository();
    for (const id of [
      GUILLEN, PAVIOLO, '2815a6b3-e104-4c86-9d0b-bc1e45b49aca',
      'e2772dda-bf27-4998-8482-885454e532ab', '6a31c2c9-56cf-4d05-87a2-96827182499a',
      MALLORQUIN, 'ab00f71d-2e76-4038-9510-166fc205e5e3', '97efa072-2fe1-48e4-b828-bf247533f374',
    ]) r.seed(id, { cancelled: true, hasActiveTvRow: false });
    r.seed(ALVEZ, { cancelled: false, hasActiveTvRow: false }); // el desincronizado
    return r;
  }

  it('EL BUG: con el pool real, el alta se COMPLETA (antes daba 404 siempre)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const port = fakePort({ listAccounts: jest.fn(async () => POOL_REAL as any) });

    const res = await makeUseCase(port, { reuse: repoConLos8DeBaja() }).execute(NUEVO, INPUT);

    expect(res.partnerCreated).toBe(true);
  });

  it('NUNCA elige el CIC corrupto ni el de ALVEZ, sea cual sea el índice del pick', async () => {
    for (let i = 0; i < POOL_REAL.length; i++) {
      // El readback post-stamp DEBE seguir al cic realmente estampado: con un cic fijo el
      // `account.cic !== cic` dispararía un TvIdentityStampUnverifiedError espurio y el test
      // mediría el fixture en vez del comportamiento.
      let estampado = '';
      const port = fakePort({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        listAccounts: jest.fn(async () => POOL_REAL as any),
        setInternalId: jest.fn(async (cic: string) => { estampado = cic; }),
        getAccountByInternalId: jest.fn()
          .mockRejectedValueOnce(new GigaredNotFoundError())
          .mockImplementation(async () => fakeAccount({ cic: estampado })),
      });

      await makeUseCase(port, { reuse: repoConLos8DeBaja(), pick: n => i % n }).execute(NUEVO, INPUT);

      const elegido = (port.register as jest.Mock).mock.calls[0][0].cic;
      expect(elegido).not.toBe(CIC_ROTO);
      expect(elegido).not.toBe('0006166000'); // ALVEZ
    }
  });

  it('el resultado NUNCA es un GigaredNotFoundError (ERR-1.3)', async () => {
    const port = fakePort({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listAccounts: jest.fn(async () => POOL_REAL as any),
      register: jest.fn(async () => { throw new GigaredNotFoundError(undefined, true); }),
    });

    const err = await makeUseCase(port, { reuse: repoConLos8DeBaja() })
      .execute(NUEVO, INPUT).catch(e => e);

    expect(err).not.toBeInstanceOf(GigaredNotFoundError);
    expect(err).toBeInstanceOf(TvNoUsableCicError);
  });
});

describe('RONDA 4 — hallazgos del review sobre la ronda 3', () => {
  /**
   * F3 — el chequeo PURO y concluyente estaba DEBAJO del I/O falible. Con un blip de Postgres,
   * un pool donde NADA es reutilizable (todas las cuentas ocupadas) salía como 503 reintentable
   * en vez de 422. Es el mismo enmascaramiento que la ronda 3 arregló a nivel agregado,
   * sobreviviendo a nivel POR ENTRADA. El chequeo puro es gratis: va primero.
   */
  it('F3 — cuentas OCUPADAS + Postgres caído → 422 (lo concluyente gana sobre lo falible)', async () => {
    const reuse = eligibilityRepo();
    jest.spyOn(reuse, 'isEligibleForCicReuse').mockRejectedValue(new Error('ECONNREFUSED 5432'));
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        fakeAccount({ cic: '0006677401', internalId: GUILLEN, email: 'a@x.com', registrationDate: '2026-01-01' }),
        fakeAccount({ cic: '0006168430', internalId: PAVIOLO, email: 'b@x.com', registrationDate: '2026-01-02' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    });

    const err = await makeUseCase(port, { reuse }).execute(NUEVO, INPUT).catch(e => e);

    // Las dos cuentas están demostrablemente ocupadas: reintentar NO puede ayudar.
    expect(err).toBeInstanceOf(TvPoolPoisonedError);
    expect(err).not.toBeInstanceOf(TvPoolUnavailableError);
    // Y no se gastó ni una consulta al mirror: el chequeo puro ya había concluido.
    expect(reuse.isEligibleForCicReuse).not.toHaveBeenCalled();
  });

  /**
   * F4 — `descartados` agrega CUATRO causas distintas (identidad no parseable, cic malformado
   * estampado, cliente no elegible, cuenta ocupada) y el mensaje nombraba UNA sola: "identidad
   * ajena". Un pool de cuentas OCUPADAS de clientes nuestros y elegibles reportaba una causa
   * que no ocurrió.
   */
  it('F4 — el mensaje NO inventa "identidad ajena" cuando la causa fue "cuenta ocupada"', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        fakeAccount({ cic: '0006677401', internalId: GUILLEN, email: 'a@x.com', registrationDate: '2026-01-01' }),
        { cic: '0006168430', internalId: PAVIOLO },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    });

    const err = await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT).catch(e => e);

    const detail = (err as TvPoolUnavailableError).detail ?? '';
    expect(detail).not.toContain('identidad ajena');
    expect(detail).toContain('ocupada');
  });

  it('F4-bis — con identidad REALMENTE ajena, el mensaje SÍ la nombra', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        poolEntry('0006832019', 'ffffffff-0000-0000-0000-000000000000'),
        poolEntry('0006107090', 'ffffffff-0000-0000-0000-000000000001'),
        poolEntry('0006411239', 'ffffffff-0000-0000-0000-000000000002'),
        { cic: '0006168430', internalId: PAVIOLO },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    });

    const err = await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT).catch(e => e);
    expect(err).toBeInstanceOf(TvPoolPoisonedError);
    expect((err as TvPoolPoisonedError).poisonedCount).toBe(3);
  });

  /**
   * F5 — EL CIC CORRUPTO SEGUÍA MUDO. Con el pool exacto del incidente del 2026-07-30 el sistema
   * dice "no hay CIC disponible" y no dejaba UNA sola línea de log con el cic ofensor. OBS-1
   * cubrió el 403 del partner —el síntoma—; la causa raíz (el string corrupto) no dejaba rastro.
   */
  it('F5 — un CIC MALFORMADO deja rastro en el log, con el valor ofensor', async () => {
    const warn = jest.spyOn(console, 'warn');
    const port = fakePort({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listAccounts: jest.fn(async () => [poolEntry(CIC_ROTO, null)] as any),
    });

    await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT).catch(e => e);

    const linea = warn.mock.calls.map(c => c.join(' ')).join(' | ');
    expect(linea).toContain(CIC_ROTO);
  });

  /**
   * F9 — señal ORTOGONAL. Los 4 campos de `crm` pueden fallar juntos ante un cambio de shape;
   * `ott.registeredDevices` vive en otra rama del payload y una cuenta con dispositivos
   * registrados NO está libre por definición. Refuerza el guard anti-Centeno sin costo.
   */
  it('F9 — una cuenta con DISPOSITIVOS registrados no está libre, aunque el crm venga vacío', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        {
          ...poolEntry('0006677401', GUILLEN),
          ott: { id: 'GIGA1', stationaryLicenses: 3, mobileLicenses: 5, registeredDevices: 2, status: null },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    });

    await expect(
      makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT),
    ).rejects.toBeInstanceOf(TvPoolPoisonedError);
    expect(port.register).not.toHaveBeenCalled();
  });

  it('F9-bis — con 0 dispositivos y el crm vacío, sigue siendo reutilizable', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        {
          ...poolEntry('0006677401', GUILLEN),
          ott: { id: 'GIGA1', stationaryLicenses: 3, mobileLicenses: 5, registeredDevices: 0, status: null },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    });

    const res = await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT);
    expect(res.partnerCreated).toBe(true);
  });

  /**
   * C3 — la conjunción de campos se testeaba EN BLOQUE (todos null o todos undefined), así que
   * `firstName`/`lastName`/`registrationDate` no decidían nada: un mutante que mirara SÓLO el
   * email sobrevivía. Es la 4ta condición de la invariante anti-Centeno: una cuenta con nombre
   * y fecha de registro pero email null se habría reutilizado.
   */
  describe('C3 — cada campo decide por separado', () => {
    const casos: { campo: string; over: Record<string, unknown> }[] = [
      { campo: 'email', over: { email: 'a@x.com' } },
      { campo: 'firstName', over: { firstName: 'JUAN' } },
      { campo: 'lastName', over: { lastName: 'PEREZ' } },
      { campo: 'registrationDate', over: { registrationDate: '2026-01-01' } },
    ];

    for (const c of casos) {
      it(`sólo ${c.campo} seteado → la cuenta NO está libre`, async () => {
        const port = fakePort({
          listAccounts: jest.fn(async () => [
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { ...poolEntry('0006677401', GUILLEN), ...c.over } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ] as any),
        });

        await expect(
          makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT),
        ).rejects.toBeInstanceOf(TvPoolPoisonedError);
        expect(port.register).not.toHaveBeenCalled();
      });
    }

    it('el string VACÍO cuenta como vacío (no como ocupado)', async () => {
      const port = fakePort({
        listAccounts: jest.fn(async () => [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { ...poolEntry('0006677401', GUILLEN), email: '', firstName: '', lastName: '' } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any),
      });

      const res = await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT);
      expect(res.partnerCreated).toBe(true);
    });
  });

  /**
   * C5 — el discriminador por email prefiere (1) la cuenta con MI internalId, (2) una huérfana
   * sin estampar, y recién (3) el primer match. TODOS los fixtures del repo devolvían UN solo
   * match, así que `matches[0]` a ciegas pasaba la suite entera. Fixture degenerado (pecado d).
   */
  it('C5 — con VARIOS matches por email, gana la MÍA, no la primera del array', async () => {
    const AJENA = 'ffffffff-1111-1111-1111-111111111111';
    const listAccounts = jest.fn(async (f?: { status?: string; email?: string }) =>
      f?.email
        ? [
            // La AJENA viene PRIMERA a propósito: si el código toma matches[0], roba.
            fakeAccount({ cic: '0001111111', internalId: AJENA }),
            fakeAccount({ cic: '0006677401', internalId: NUEVO }),
          ]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        : ([poolEntry('0006677401', GUILLEN)] as any),
    );
    const port = fakePort({
      listAccounts,
      register: jest.fn(async () => { throw new GigaredRejectedError('dup', 'Email ya utilizado'); }),
    });

    const res = await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT);

    expect(res.recovered).toBe(true);
    expect(res.account.cic).toBe('0006677401');
    expect(port.setInternalId).not.toHaveBeenCalled();
  });

  /**
   * C6 — el docblock del guard promete "y SE LOGUEA", y el propio código dice que un rastro
   * mudo es el pecado que OBS-1 corrige. Borrar los dos warns sobrevivía la suite entera.
   */
  it('C6 — la cuenta OCUPADA deja rastro en el log', async () => {
    const warn = jest.spyOn(console, 'warn');
    const port = fakePort({
      listAccounts: jest.fn(async () => [
        fakeAccount({ cic: '0006677401', internalId: GUILLEN, email: 'a@x.com' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    });

    await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT).catch(e => e);

    const linea = warn.mock.calls.map(c => c.join(' ')).join(' | ');
    expect(linea).toContain('0006677401');
  });

  it('C6-bis — los campos AUSENTES también dejan rastro', async () => {
    const warn = jest.spyOn(console, 'warn');
    const port = fakePort({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listAccounts: jest.fn(async () => [{ cic: '0006677401', internalId: GUILLEN }] as any),
    });

    await makeUseCase(port, { reuse: eligibilityRepo() }).execute(NUEVO, INPUT).catch(e => e);

    const linea = warn.mock.calls.map(c => c.join(' ')).join(' | ');
    expect(linea).toContain('0006677401');
  });
});

