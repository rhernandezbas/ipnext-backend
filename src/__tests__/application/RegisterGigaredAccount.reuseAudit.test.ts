/**
 * gigared-tv-cic-reuse (Fase 6, spec AUD-1) — rastro de la reutilización de un CIC.
 *
 * WHY: la forense del incidente Centeno fue ARQUEOLOGÍA PURA porque nadie había registrado qué
 * CIC se había reciclado ni de quién era (es la lección del breadcrumb B6). Ahora que el
 * sistema reutiliza CICs A PROPÓSITO y sin pedirle confirmación al operador, el rastro deja de
 * ser un lujo: es lo que hace auditable la decisión.
 *
 * Es BEST-EFFORT: un fallo del rastro jamás puede abortar un alta que el partner YA completó.
 */
import { RegisterGigaredAccount } from '@application/use-cases/gigared/RegisterGigaredAccount';
import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import { GigaredNotFoundError, GigaredRejectedError, TvIdentityStampUnverifiedError } from '@domain/errors/gigared';
import { InMemoryTvCicReuseEligibilityRepository } from '@infrastructure/adapters/in-memory/InMemoryTvCicReuseEligibilityRepository';
import { InMemoryAuditEventRepository } from '@infrastructure/adapters/in-memory/InMemoryAuditEventRepository';
import { InMemoryTvActivationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository';

const GUILLEN = 'bb25d17b-4770-48e3-9686-d9d9929e1898';
/**
 * RONDA 4 (C1) — el dueño anterior tiene `internalId !== clientId` A PROPÓSITO (identidad de
 * re-alta, con sufijo de seq). Con GUILLEN pelado ambos campos valían lo mismo, así que un
 * mutante que INTERCAMBIARA `internalId` con `clientId` en `beforeJson` sobrevivía: la ceguera
 * al swap era una propiedad del FIXTURE, no de la aserción. `toEqual` no alcanzaba.
 */
const MALLORQUIN = '7d4e3ec6-34b0-440c-b7c2-6f263f3e6f8f';
const MALLORQUIN_SEQ1 = MALLORQUIN + '-1';
const NUEVO = '11111111-2222-3333-4444-555555555555';

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  return {
    cic: '0006677401', gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '2026-01-19', services: [], internalId: NUEVO, clientId: NUEVO, ott: null,
    ...over,
  };
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
    getAccountByInternalId: jest.fn()
      .mockRejectedValueOnce(new GigaredNotFoundError())
      .mockResolvedValue(fakeAccount()),
    // FIX WAVE F4 — cuenta del POOL: realmente libre (todo null), si no el guard nuevo la
    // rechaza y la reutilización no llega a ocurrir.
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

function reuseRepo(): InMemoryTvCicReuseEligibilityRepository {
  const r = new InMemoryTvCicReuseEligibilityRepository();
  r.seed(GUILLEN, { cancelled: true, hasActiveTvRow: false });
  r.seed(MALLORQUIN, { cancelled: true, hasActiveTvRow: false });
  return r;
}

function makeUseCase(port: GigaredPort, audit?: InMemoryAuditEventRepository) {
  const reuse = reuseRepo();
  return new RegisterGigaredAccount(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    port, customerLookup as any, contractLookup as any,
    undefined, undefined, undefined, undefined, undefined,
    () => 0, reuse,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audit as any,
  );
}

const INPUT = {
  firstName: 'X', lastName: 'Y', email: 'ignored@x.com', sendActivationEmail: false,
  contractId: 'ct-1', actorId: 'user-9', actorName: 'JimenaD',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const poolReutilizable = [poolEntry('0006677401', MALLORQUIN_SEQ1)] as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const poolLimpio = [poolEntry('0006677401', null)] as any;


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

describe('gigared-tv-cic-reuse AUD-1 — auditoría del CIC reutilizado', () => {
  it('AUD-1.1 — un alta sobre un CIC REUTILIZADO emite tv.cic_reused con el dueño anterior', async () => {
    const audit = new InMemoryAuditEventRepository();
    const port = fakePort({ listAccounts: jest.fn(async () => poolReutilizable) });

    await makeUseCase(port, audit).execute(NUEVO, INPUT);

    const page = await audit.list({});
    const ev = page.items.find(e => e.action === 'tv.cic_reused');
    expect(ev).toBeDefined();
    expect(ev!.entityType).toBe('GigaredAccount');
    expect(ev!.entityId).toBe('0006677401');
    // RONDA 3 — antes esto era `JSON.stringify(...).toContain(GUILLEN)`, que es
    // ESTRUCTURALMENTE CIEGO: en `beforeJson` tanto `internalId` como `clientId` valen GUILLEN,
    // así que un mutante que INTERCAMBIE los campos pasaba igual. Y `contractId` no se
    // verificaba nunca. Se assertea la forma EXACTA.
    // internalId y clientId son DISTINTOS: un swap de campos ahora muere.
    expect(ev!.beforeJson).toEqual({ internalId: MALLORQUIN_SEQ1, clientId: MALLORQUIN });
    expect(ev!.afterJson).toEqual({
      internalId: NUEVO,
      clientId: NUEVO,
      contractId: 'ct-1',
    });
    expect(ev!.actorId).toBe('user-9');
    expect(ev!.actorLogin).toBe('JimenaD');
  });

  /**
   * RONDA 4 (C2) — AUD-1.2 sólo tenía aserción NEGATIVA (`not.toContain('reusedFrom')`). El
   * lado POSITIVO —el rastro que el operador ve en el Historial de TV— no estaba testeado en
   * ningún archivo: se podía apagar entero (`reason: null`) con el CI en verde.
   */
  it('AUD-1.2 — el reason del Historial de TV nombra al dueño anterior EXACTO', async () => {
    const eventos = new InMemoryTvActivationEventRepository();
    const port = fakePort({ listAccounts: jest.fn(async () => poolReutilizable) });

    const uc = new RegisterGigaredAccount(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      port, customerLookup as any, contractLookup as any,
      undefined, undefined, undefined, undefined, eventos,
      () => 0, reuseRepo(),
    );
    await uc.execute(NUEVO, INPUT);

    const ev = await eventos.listByClient(NUEVO);
    expect(ev).toHaveLength(1);
    expect(ev[0].reason).toBe('reusedFrom:' + MALLORQUIN_SEQ1);
  });

  it('AUD-1.4 — un alta sobre un CIC LIMPIO NO emite el evento de reutilización', async () => {
    const audit = new InMemoryAuditEventRepository();
    const port = fakePort({ listAccounts: jest.fn(async () => poolLimpio) });

    await makeUseCase(port, audit).execute(NUEVO, INPUT);

    const page = await audit.list({});
    expect(page.items.find(e => e.action === 'tv.cic_reused')).toBeUndefined();
  });

  it('AUD-1.3 — si la auditoría FALLA, el alta ya completada NO se aborta', async () => {
    const audit = new InMemoryAuditEventRepository();
    jest.spyOn(audit, 'record').mockRejectedValue(new Error('audit caído'));
    const port = fakePort({ listAccounts: jest.fn(async () => poolReutilizable) });

    const res = await makeUseCase(port, audit).execute(NUEVO, INPUT);

    expect(res.partnerCreated).toBe(true);
  });

  it('F8 — el rastro se emite aunque el READBACK falle después (el alias YA quedó grabado)', async () => {
    /**
     * El review encontró que la auditoría se perdía justo cuando más importa:
     *   1. `setInternalId(cic, miId)` sale OK → el alias queda GRABADO EN EL PARTNER, para
     *      siempre (el mapeo es append-only, no hay unlink).
     *   2. el readback post-stamp 404ea por lag de replicación → TvIdentityStampUnverifiedError.
     *   3. `execute` nunca llega al bloque de auditoría → 503 al operador.
     *   4. en el reintento, el probe reancla y devuelve SIN `reusedFrom` → el evento no se
     *      emite NUNCA.
     * Resultado: el CIC cambió de dueño y el rastro es cero — la "arqueología pura" del
     * incidente Centeno que esta feature vino a evitar.
     */
    const audit = new InMemoryAuditEventRepository();
    const port = fakePort({
      listAccounts: jest.fn(async () => poolReutilizable),
      // El probe inicial 404ea; el readback POST-stamp también (lag de replicación).
      getAccountByInternalId: jest.fn().mockRejectedValue(new GigaredNotFoundError()),
    });

    await expect(makeUseCase(port, audit).execute(NUEVO, INPUT)).rejects.toBeInstanceOf(
      TvIdentityStampUnverifiedError,
    );

    // El estampado ocurrió → el rastro TIENE que existir, aunque el alta haya fallado después.
    expect(port.setInternalId).toHaveBeenCalledWith('0006677401', NUEVO);
    const page = await audit.list({});
    const ev = page.items.find(e => e.action === 'tv.cic_reused');
    expect(ev).toBeDefined();
    expect(ev!.beforeJson).toEqual({ internalId: MALLORQUIN_SEQ1, clientId: MALLORQUIN });
  });

  it('F8 — no se emite DOS veces cuando el alta sí completa', async () => {
    const audit = new InMemoryAuditEventRepository();
    const port = fakePort({ listAccounts: jest.fn(async () => poolReutilizable) });

    await makeUseCase(port, audit).execute(NUEVO, INPUT);

    const page = await audit.list({});
    expect(page.items.filter(e => e.action === 'tv.cic_reused')).toHaveLength(1);
  });

  it('F8-bis (REGRESIÓN DEL FIX WAVE) — si el discriminador REDIRIGE a otro cic, NO se audita', async () => {
    /**
     * El fix F8 movió la emisión a `intentarConCandidato`, justo tras `setInternalId`. Pero
     * `cic` es una variable MUTADA: en la rama huérfana del discriminador por email pasa a ser
     * `match.cic`, otra cuenta. El guard que evitaba la atribución falsa (`r.cic ===
     * candidato.cic`) quedó del lado del RETORNO, río abajo del nuevo punto de emisión.
     *
     * Resultado probado por el revisor: un alta 201 OK emitía `tv.cic_reused` sobre un cic que
     * NUNCA fue de GUILLEN, y encima sin que hubiera habido reutilización alguna (la cuenta
     * final era una huérfana propia). Los dos rastros del mismo alta se contradecían: el
     * `reason` del TvActivationEvent quedaba en null y la auditoría inventaba un cambio de dueño.
     *
     * "Una auditoría que miente es peor que no tenerla" — el comentario del propio código.
     */
    const audit = new InMemoryAuditEventRepository();
    const listAccounts = jest.fn(async (f?: { status?: string; email?: string }) =>
      f?.email
        // Huérfana MÍA (sin estampar) en OTRO cic → el flujo se reanuda sobre ella.
        ? [fakeAccount(poolEntry('0009999999', null))]
        : poolReutilizable,
    );
    const port = fakePort({
      listAccounts,
      register: jest.fn(async () => { throw new GigaredRejectedError('dup', 'Email ya utilizado'); }),
      getAccountByInternalId: jest.fn()
        .mockRejectedValueOnce(new GigaredNotFoundError())
        .mockResolvedValue(fakeAccount({ cic: '0009999999' })),
    });

    await makeUseCase(port, audit).execute(NUEVO, INPUT);

    const eventos = (await audit.list({})).items.filter(e => e.action === 'tv.cic_reused');
    expect(eventos).toHaveLength(0);
  });

  /**
   * RONDA 3 (#4) — LOS DOS RASTROS DEL MISMO ALTA NO PUEDEN CONTRADECIRSE.
   *
   * Había DOS guardas para el mismo hecho y podían discrepar: `cic === cicInicial` gobernaba la
   * auditoría, y `r.cic === candidato.cic` gobernaba el `reusedFrom` que alimenta el `reason`
   * del Historial de TV. En la rama "MÍA ya estampada" del discriminador por email **no se
   * llama a `setInternalId`** —no hay cambio de dueño— pero si el cic coincidía, el `reason`
   * afirmaba una reutilización que la auditoría no respaldaba.
   *
   * La condición honesta para AMBOS es una sola: ¿corrió `setInternalId` en ESTE intento?
   */
  it('#4 — rama "ya estampada" (sin setInternalId): ni auditoría NI reason de reutilización', async () => {
    const audit = new InMemoryAuditEventRepository();
    const eventos = new InMemoryTvActivationEventRepository();
    const listAccounts = jest.fn(async (f?: { status?: string; email?: string }) =>
      f?.email
        // MISMO cic que el candidato, ya estampado con MI identidad ⇒ no se estampa de nuevo.
        ? [fakeAccount({ cic: '0006677401', internalId: NUEVO })]
        : poolReutilizable,
    );
    const port = fakePort({
      listAccounts,
      register: jest.fn(async () => { throw new GigaredRejectedError('dup', 'Email ya utilizado'); }),
    });

    const uc = new RegisterGigaredAccount(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      port, customerLookup as any, contractLookup as any,
      undefined, undefined, undefined, undefined, eventos,
      () => 0, reuseRepo(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      audit as any,
    );
    await uc.execute(NUEVO, INPUT);

    expect(port.setInternalId).not.toHaveBeenCalled();

    // Ninguno de los dos rastros puede afirmar una reutilización que no ocurrió.
    expect((await audit.list({})).items.filter(e => e.action === 'tv.cic_reused')).toHaveLength(0);
    const ev = await eventos.listByClient(NUEVO);
    expect(ev).toHaveLength(1);
    expect(ev[0].reason ?? '').not.toContain('reusedFrom');
  });

  it('sin repo de auditoría cableado, el alta funciona igual (dependencia opcional)', async () => {
    const port = fakePort({ listAccounts: jest.fn(async () => poolReutilizable) });
    await expect(makeUseCase(port).execute(NUEVO, INPUT)).resolves.toBeDefined();
  });
});
