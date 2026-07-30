/**
 * gigared-tv-cic-reuse — FIX WAVE F1/F2. Test HONESTO del requisito ERR-1.3.
 *
 * ⚠️ POR QUÉ EXISTE ESTE ARCHIVO: el test original de ERR-1.3 (`gigared.routes.cicReuse.test.ts`)
 * era TAUTOLÓGICO. Enumeraba a mano los 4 errores que el autor DECIDIÓ lanzar y verificaba que
 * ninguno mapeara a 404 — **excluyendo `GigaredNotFoundError`, que es el único que da 404**.
 * Certificaba la conclusión eligiendo las premisas, y por eso pasó en verde mientras el bug
 * seguía vivo en 3 de las 8 llamadas al partner.
 *
 * Este test hace lo contrario: inyecta un `GigaredNotFoundError` en **CADA** punto donde el use
 * case le habla al partner, y exige que NUNCA salga un `GigaredNotFoundError` crudo (que el
 * router traduce a 404 "Gigared account not found" — el mensaje exacto del incidente).
 *
 * Si mañana alguien agrega una llamada nueva al partner sin protegerla, este test la caza.
 */
import { RegisterGigaredAccount } from '@application/use-cases/gigared/RegisterGigaredAccount';
import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import {
  GigaredNotFoundError,
  GigaredRejectedError,
  GigaredAuthError,
  GigaredNotConfiguredError,
  GigaredUnavailableError,
  TvIdentityStampUnverifiedError,
} from '@domain/errors/gigared';
import { InMemoryTvCicReuseEligibilityRepository } from '@infrastructure/adapters/in-memory/InMemoryTvCicReuseEligibilityRepository';

const GUILLEN = 'bb25d17b-4770-48e3-9686-d9d9929e1898';
const NUEVO = '11111111-2222-3333-4444-555555555555';

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  return {
    cic: '0006677401', gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '2026-01-19', services: [], internalId: NUEVO, clientId: NUEVO, ott: null,
    ...over,
  };
}

/** Pool con DOS reutilizables, para que el loop tenga a dónde ir si descarta el primero. */
const POOL = [
  poolEntry('0006677401', GUILLEN),
  poolEntry('0006168430', 'd888bea2-7833-494b-b3a6-b246284ef4e9'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as any;

/**
 * RONDA 3 — entrada REAL del listado del pool. Las 10 cuentas verificadas contra el partner el
 * 2026-07-30 traen `email`/`firstName`/`lastName`/`registrationDate` en **null explícito**, y
 * eso es justo lo que el guard mira ahora (sin llamada extra: el dato ya viene en el listado).
 * Un literal `{cic, internalId}` pelado deja esos campos en `undefined` = shape desconocido.
 */
function poolEntry(cic: string, internalId: string | null): GigaredAccount {
  return fakeAccount({ cic, internalId, email: null, firstName: null, lastName: null, registrationDate: null });
}

function basePort(over: Partial<GigaredPort> = {}): GigaredPort {
  return {
    getSummary: jest.fn(),
    listAccounts: jest.fn(async () => POOL),
    getAccountByInternalId: jest.fn()
      .mockRejectedValueOnce(new GigaredNotFoundError())
      .mockResolvedValue(fakeAccount()),
    // FIX WAVE F4 — cuenta del POOL: realmente libre en los CUATRO campos que mira el guard.
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

const customerLookup = { findById: async (id: string) => ({ id, grClienteId: '9', name: 'PEREZ JUAN' }) };
const contractLookup = { findById: async (id: string) => ({ id, clientId: NUEVO, grContratoId: '204382' }) };

function makeUseCase(port: GigaredPort) {
  const reuse = new InMemoryTvCicReuseEligibilityRepository();
  reuse.seed(GUILLEN, { cancelled: true, hasActiveTvRow: false });
  reuse.seed('d888bea2-7833-494b-b3a6-b246284ef4e9', { cancelled: true, hasActiveTvRow: false });
  return new RegisterGigaredAccount(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    port, customerLookup as any, contractLookup as any,
    undefined, undefined, undefined, undefined, undefined, () => 0, reuse,
  );
}

const INPUT = {
  firstName: 'X', lastName: 'Y', email: 'i@x.com', sendActivationEmail: false, contractId: 'ct-1',
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

const NF = () => new GigaredNotFoundError();

describe('ERR-1.3 (HONESTO) — ninguna llamada al partner puede filtrar un 404 crudo', () => {
  it('el listado del POOL que 404ea → no es GigaredNotFoundError', async () => {
    const port = basePort({ listAccounts: jest.fn(async () => { throw NF(); }) });
    const err = await makeUseCase(port).execute(NUEVO, INPUT).catch(e => e);
    expect(err).not.toBeInstanceOf(GigaredNotFoundError);
  });

  it('ACTIVATE que 404ea → no es GigaredNotFoundError (la cuenta YA existe: identidad sin verificar)', async () => {
    const port = basePort({ activate: jest.fn(async () => { throw NF(); }) });
    const err = await makeUseCase(port).execute(NUEVO, INPUT).catch(e => e);
    expect(err).not.toBeInstanceOf(GigaredNotFoundError);
    expect(err).toBeInstanceOf(TvIdentityStampUnverifiedError);
  });

  it('SETINTERNALID que 404ea → no es GigaredNotFoundError', async () => {
    const port = basePort({ setInternalId: jest.fn(async () => { throw NF(); }) });
    const err = await makeUseCase(port).execute(NUEVO, INPUT).catch(e => e);
    expect(err).not.toBeInstanceOf(GigaredNotFoundError);
    expect(err).toBeInstanceOf(TvIdentityStampUnverifiedError);
  });

  it('el listAccounts({email}) del recovery que 404ea → no es GigaredNotFoundError', async () => {
    // El register rechaza (duplicado) → se consulta por email → esa consulta 404ea.
    const listAccounts = jest.fn(async (f?: { status?: string; email?: string }) => {
      if (f?.email) throw NF();
      return POOL;
    });
    const port = basePort({
      listAccounts,
      register: jest.fn(async () => { throw new GigaredRejectedError('dup', 'Email ya utilizado'); }),
    });

    const err = await makeUseCase(port).execute(NUEVO, INPUT).catch(e => e);
    expect(err).not.toBeInstanceOf(GigaredNotFoundError);
  });

  it('el readback post-stamp que 404ea → TvIdentityStampUnverifiedError (ya estaba bien)', async () => {
    const port = basePort({
      getAccountByInternalId: jest.fn().mockRejectedValue(NF()),
    });
    const err = await makeUseCase(port).execute(NUEVO, INPUT).catch(e => e);
    expect(err).not.toBeInstanceOf(GigaredNotFoundError);
    expect(err).toBeInstanceOf(TvIdentityStampUnverifiedError);
  });

  it('F5 — el catch del pool NO aplasta los errores que ya tienen código propio', async () => {
    // El wrap indiscriminado convertía TODO fallo del listado en un 503 "reintentá en unos
    // segundos": con la API key vencida el operador reintentaría para siempre, y el `detail`
    // RFC 9457 que #47g existe para exponer se perdía. Sólo el NotFound necesita traducción.
    const casos: { err: Error; nombre: string }[] = [
      { err: new GigaredAuthError('Gigared API key is invalid', 'Clave inválida'), nombre: 'auth' },
      { err: new GigaredNotConfiguredError(), nombre: 'no configurado' },
      { err: new GigaredUnavailableError('caído', 'timeout'), nombre: 'upstream' },
    ];

    for (const c of casos) {
      const port = basePort({ listAccounts: jest.fn(async () => { throw c.err; }) });
      const got = await makeUseCase(port).execute(NUEVO, INPUT).catch(e => e);
      expect({ caso: c.nombre, code: (got as { code?: string }).code }).toEqual({
        caso: c.nombre,
        code: c.err instanceof Error ? (c.err as unknown as { code: string }).code : '',
      });
    }
  });

  it('F5 — el NotFound del pool SÍ se traduce (es lo único que ERR-1.1 tapa)', async () => {
    const port = basePort({ listAccounts: jest.fn(async () => { throw NF(); }) });
    const err = await makeUseCase(port).execute(NUEVO, INPUT).catch(e => e);
    expect((err as { code?: string }).code).toBe('TV_POOL_UNAVAILABLE');
  });

  it('F3 — un not-found INDETERMINADO en el register NO reintenta con otro CIC (anti doble cobro)', async () => {
    // El comentario original afirmaba "un not-found en el register prueba que NADA se creó".
    // Es FALSO: `mapError` también produce GigaredNotFoundError desde un 424
    // `external-service-error` con detail "no se encontró" — y 424 significa que el partner
    // ACEPTÓ el POST y su downstream (el CUA) falló ⇒ el estado queda DESCONOCIDO. Reintentar
    // con otro cic ahí puede crear una SEGUNDA cuenta real (doble cobro, lección F1).
    //
    // Sólo el 403 `cic-ownership-error` prueba que el partner rechazó ANTES de crear nada; ése
    // viene marcado con `cicNotOwned`.
    const register = jest.fn(async () => { throw new GigaredNotFoundError(); }); // SIN la marca
    const port = basePort({ register });

    const err = await makeUseCase(port).execute(NUEVO, INPUT).catch(e => e);

    expect(register).toHaveBeenCalledTimes(1); // NO se probó un segundo cic
    expect(err).not.toBeInstanceOf(GigaredNotFoundError);
    // Estado indeterminado ⇒ 503 retriable; el probe idempotente converge sin re-registrar.
    expect(err).toBeInstanceOf(TvIdentityStampUnverifiedError);
  });

  it('F3 — un not-found MARCADO como "cic ajeno" SÍ reintenta (es pre-write seguro)', async () => {
    const register = jest.fn()
      .mockRejectedValueOnce(new GigaredNotFoundError(undefined, true)) // 403 cic-ownership
      .mockResolvedValue(undefined);
    let estampado = '';
    const port = basePort({
      register,
      setInternalId: jest.fn(async (cic: string) => { estampado = cic; }),
      getAccountByInternalId: jest.fn()
        .mockRejectedValueOnce(NF())
        .mockImplementation(async () => fakeAccount({ cic: estampado })),
    });

    const res = await makeUseCase(port).execute(NUEVO, INPUT);

    expect(register).toHaveBeenCalledTimes(2);
    expect(res.partnerCreated).toBe(true);
  });

  it('BARRIDO: 404 en CUALQUIER punto — jamás sale un GigaredNotFoundError', async () => {
    // RONDA 4 (C7) — se quitó el caso `getAccountByCic`: la ronda 3 ELIMINÓ esa llamada del
    // camino del register (la verificación pasó a ser pura sobre el dato del listado), así que
    // el mock nunca se invocaba y el caso pasaba TRIVIALMENTE. Cobertura fantasma justo en el
    // test que existe para que no queden huecos. El test hermano "CERO llamadas extra" fija
    // que ese método NO se llama; tener los dos era contradictorio.
    const puntos: { nombre: string; over: Partial<GigaredPort> }[] = [
      { nombre: 'listAccounts(pool)',  over: { listAccounts: jest.fn(async () => { throw NF(); }) } },
      { nombre: 'register',            over: { register: jest.fn(async () => { throw NF(); }) } },
      { nombre: 'activate',            over: { activate: jest.fn(async () => { throw NF(); }) } },
      { nombre: 'setInternalId',       over: { setInternalId: jest.fn(async () => { throw NF(); }) } },
      { nombre: 'readback',            over: { getAccountByInternalId: jest.fn().mockRejectedValue(NF()) } },
    ];

    for (const p of puntos) {
      const err = await makeUseCase(basePort(p.over)).execute(NUEVO, INPUT).catch(e => e);
      expect({ punto: p.nombre, esNotFound: err instanceof GigaredNotFoundError }).toEqual({
        punto: p.nombre,
        esNotFound: false,
      });
    }
  });
});
