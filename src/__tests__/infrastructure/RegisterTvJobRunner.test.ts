/**
 * gigared-alta-asincrona W3 — RegisterTvJobRunner.
 *
 * Molde de `CancelTvJobRunner`: cáscara asíncrona alrededor de un use case que NO se toca.
 * `RegisterGigaredAccount` se invoca TAL CUAL — toda la idempotencia (probe por internal_id,
 * discriminador por email, avance diferido del seq) ya vive ahí y este change no la reescribe.
 *
 * El test central (W3.3) es el que justifica el change entero: la decisión de producto es que el
 * operador "ve el error y ya", así que va a REINTENTAR — es lo que hizo con Calabria, Abello y
 * Aceste, y cada reintento a ciegas quemó al cliente de forma permanente. Entonces el reintento
 * tiene que ser seguro POR CONSTRUCCIÓN.
 *
 * Por eso el partner se simula con una MÁQUINA DE ESTADO (`PartnerSim`) en vez de con mocks que
 * devuelven lo que uno quiere oír: lo que hay que medir es cuántas CUENTAS quedaron creadas del
 * lado del partner, y eso un `jest.fn()` que siempre resuelve no lo puede decir.
 */
import { RegisterTvJobRunner } from '@infrastructure/scheduling/RegisterTvJobRunner';
import type { RegisterTvActor } from '@infrastructure/scheduling/RegisterTvJobRunner';
import { RegisterGigaredAccount } from '@application/use-cases/gigared/RegisterGigaredAccount';
import { TV_REGISTER_JOB_TTL_MS, isTvRegisterJobActive } from '@domain/gigared/tvRegisterJob';
import { InMemoryClientTvRegisterStatusRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvRegisterStatusRepository';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryClientTvCancellationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvCancellationRepository';
import { InMemoryClientTvActivationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvActivationRepository';
import { InMemoryTvActivationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository';
import { GigaredNotFoundError, GigaredRejectedError, GigaredUnavailableError, TvEmailOwnedByOtherError, TvPoolPoisonedError, TvIdentityStampUnverifiedError } from '@domain/errors/gigared';
import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import type { TvRegisterJobResult, ClientTvRegisterStatusRepository } from '@domain/ports/ClientTvRegisterStatusRepository';

const CUSTOMER = 'cust-1';
const CONTRACT = 'contract-1';

// ---------------------------------------------------------------------------
// PartnerSim — máquina de estado del partner (NO un mock complaciente)
// ---------------------------------------------------------------------------

interface CuentaSim {
  cic: string;
  email: string | null;
  internalId: string | null;
  registrada: boolean;
  activada: boolean;
}

/**
 * Simula las reglas del partner que importan para la idempotencia:
 *  - el email es ÚNICO: un segundo `register` con el mismo email es RECHAZADO (así se comportó
 *    con Calabria/Abello/Aceste — el `register` duplicado no crea, rechaza).
 *  - una cuenta ya registrada sale del pool `unregistered`.
 *  - el `internal_id` sólo queda estampado si `setInternalId` llegó a correr.
 */
class PartnerSim {
  readonly cuentas = new Map<string, CuentaSim>();
  /** Cuántas CUENTAS NUEVAS quedaron creadas del lado del partner. Es la métrica del daño. */
  cuentasCreadas = 0;
  /** Cuántas veces se INVOCÓ el endpoint de register (creando o siendo rechazado). */
  registerCalls = 0;
  activateCalls = 0;
  /** Cuántos `activate` seguidos van a fallar con 429 (el bug real del 2026-08-06). */
  fallosDeActivate = 0;
  /** Lag de replicación: el readback post-stamp 404ea aunque el stamp SÍ persistió. */
  fallosDeReadback = 0;

  constructor(cicsLibres: string[]) {
    for (const cic of cicsLibres) {
      this.cuentas.set(cic, { cic, email: null, internalId: null, registrada: false, activada: false });
    }
  }

  private toAccount(c: CuentaSim): GigaredAccount {
    return {
      cic: c.cic,
      gigaredId: c.registrada ? `1${c.cic.slice(-3)}` : null,
      email: c.email,
      firstName: c.registrada ? 'N' : null,
      lastName: c.registrada ? 'A' : null,
      registrationDate: c.registrada ? '2026-08-10' : null,
      services: [],
      internalId: c.internalId,
      clientId: c.internalId ? c.internalId.replace(/-\d+$/, '') : null,
      ott: null,
    };
  }

  port(): GigaredPort {
    return {
      getSummary: jest.fn(async () => ({ accounts: { registered: 0, unregistered: 0, total: 0 }, services: [] })),

      listAccounts: jest.fn(async (filter?: { status?: string; email?: string }) => {
        const todas = [...this.cuentas.values()];
        if (filter?.email) return todas.filter(c => c.email === filter.email).map(c => this.toAccount(c));
        if (filter?.status === 'unregistered') return todas.filter(c => !c.registrada).map(c => this.toAccount(c));
        return todas.map(c => this.toAccount(c));
      }),

      getAccountByInternalId: jest.fn(async (internalId: string) => {
        const hit = [...this.cuentas.values()].find(c => c.internalId === internalId);
        if (!hit) throw new GigaredNotFoundError();
        // Lag de replicación: la cuenta EXISTE estampada pero el partner todavía no la resuelve.
        if (this.fallosDeReadback > 0) { this.fallosDeReadback--; throw new GigaredNotFoundError(); }
        return this.toAccount(hit);
      }),

      getAccountByCic: jest.fn(async (cic: string) => {
        const hit = this.cuentas.get(cic);
        if (!hit) throw new GigaredNotFoundError();
        return this.toAccount(hit);
      }),

      register: jest.fn(async (input: { cic: string; email: string }) => {
        this.registerCalls++;
        const emailTomado = [...this.cuentas.values()].some(c => c.registrada && c.email === input.email);
        if (emailTomado) throw new GigaredRejectedError('Conflict', 'email already in use');
        const cuenta = this.cuentas.get(input.cic);
        if (!cuenta) throw new GigaredNotFoundError();
        cuenta.registrada = true;
        cuenta.email = input.email;
        this.cuentasCreadas++;
      }),

      activate: jest.fn(async (_input: { cic: string; email: string }) => {
        this.activateCalls++;
        if (this.fallosDeActivate > 0) {
          this.fallosDeActivate--;
          // Lo que devolvió el partner el 2026-08-06: 429 sin Retry-After.
          throw new GigaredUnavailableError('Gigared API is unavailable', 'HTTP 429 rate limit');
        }
        const cuenta = this.cuentas.get(_input.cic);
        if (cuenta) cuenta.activada = true;
      }),

      setInternalId: jest.fn(async (cic: string, internalId: string) => {
        const cuenta = this.cuentas.get(cic);
        if (!cuenta) throw new GigaredNotFoundError();
        cuenta.internalId = internalId;
      }),

      addService: jest.fn(async () => {}),
      removeService: jest.fn(async () => {}),
      setOtt: jest.fn(async () => {}),
      changePassword: jest.fn(async () => {}),
      renewCic: jest.fn(async () => ({ oldCic: '0000009001', newCic: '0000009099' })),
    };
  }
}

// ---------------------------------------------------------------------------
// Armado del runner con adapters in-memory (nunca mocks de Prisma)
// ---------------------------------------------------------------------------

interface BuildOpts {
  sim?: PartnerSim;
  /** Marca al cliente como dado de baja → el alta es una RE-ALTA y el seq entra en juego. */
  reAlta?: boolean;
  activation?: InMemoryClientTvActivationRepository;
  registerStatus?: InMemoryClientTvRegisterStatusRepository;
  /** Rompe el reconcile local (best-effort) — no debe abortar el alta. */
  romperReconcile?: boolean;
  /** Cada cuánto late el heartbeat. Los tests lo achican para no esperar 30 s reales. */
  heartbeatMs?: number;
  /** Reemplaza el use case entero (para simular un alta que se cuelga o que explota). */
  registerAccountStub?: { execute: (...a: never[]) => Promise<unknown> };
}

async function build(opts: BuildOpts = {}) {
  const sim = opts.sim ?? new PartnerSim(['0000009001', '0000009002', '0000009003']);
  const port = sim.port();

  const csRepo = new InMemoryContractServiceRepository();
  const catalog = new InMemoryServiceCatalogRepository();
  const cat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (csRepo as any).catalog[cat.id] = { name: cat.name, label: cat.label };
  if (opts.romperReconcile) jest.spyOn(csRepo, 'add').mockRejectedValue(new Error('db down'));

  const customerLookup = { findById: async (id: string) => ({ id, grClienteId: '243200', name: 'PEREZ JUAN' }) };
  const contractLookup = { findById: async (id: string) => ({ id, clientId: CUSTOMER, grContratoId: '204382' }) };

  const tvCancellation = new InMemoryClientTvCancellationRepository();
  if (opts.reAlta) tvCancellation.seedCancelled(CUSTOMER);
  const activation = opts.activation ?? new InMemoryClientTvActivationRepository();
  const eventRepo = new InMemoryTvActivationEventRepository();
  const registerStatus = opts.registerStatus ?? new InMemoryClientTvRegisterStatusRepository();

  const registerAccount = new RegisterGigaredAccount(
    port, customerLookup, contractLookup, csRepo, catalog,
    tvCancellation, activation, eventRepo,
    // pick determinístico: siempre el primer candidato del pool.
    () => 0,
  );

  const runner = new RegisterTvJobRunner(
    (opts.registerAccountStub ?? registerAccount) as unknown as RegisterGigaredAccount,
    registerStatus,
    opts.heartbeatMs,
  );

  /**
   * Corre el job como lo hace la RUTA: primero la reserva atómica, después el runner con el sello
   * de esa reserva como fence token. Llamar a `run()` con un token inventado sería testear un
   * camino que producción no tiene.
   */
  const correr = async (actor?: RegisterTvActor, customerId = CUSTOMER) => {
    const reservadoEn = new Date();
    const ok = await registerStatus.tryReserve(customerId, reservadoEn, TV_REGISTER_JOB_TTL_MS);
    if (!ok) throw new Error('la reserva del alta no se pudo tomar (¿job vivo?)');
    await runner.run(customerId, input(), reservadoEn, actor);
    return reservadoEn;
  };

  return { runner, registerStatus, sim, port, activation, tvCancellation, eventRepo, correr };
}

const input = () => ({
  firstName: 'Juan',
  lastName: 'Pérez',
  email: 'loquesea@fe.com',
  sendActivationEmail: false,
  contractId: CONTRACT,
});

// ---------------------------------------------------------------------------
// W3.1 / W3.2 — transiciones pending → running → done | failed
// ---------------------------------------------------------------------------

describe('RegisterTvJobRunner — transiciones de estado (W3.1/W3.2)', () => {
  it('éxito: deja el job en done con el result del alta', async () => {
    const { registerStatus, sim, correr } = await build();
    await correr();

    const row = await registerStatus.getStatus(CUSTOMER);
    expect(row?.status).toBe('done');
    const result = row!.result as TvRegisterJobResult;
    expect(result.partnerCreated).toBe(true);
    expect(result.account.cic).toBe('0000009001');
    expect(sim.cuentasCreadas).toBe(1);
  });

  it('pasa por running ANTES de terminar (la transición no se saltea)', async () => {
    const { registerStatus, correr } = await build();
    const vistos: string[] = [];
    const original = registerStatus.compareAndSet.bind(registerStatus);
    jest.spyOn(registerStatus, 'compareAndSet').mockImplementation(async (id, esperado, row) => {
      vistos.push(row.status);
      return original(id, esperado, row);
    });

    await correr();
    expect(vistos).toEqual(['running', 'done']);
  });

  it('startedAt se sella al RESERVAR y es inmutable hasta el estado terminal', async () => {
    const { registerStatus, correr } = await build();
    const antes = Date.now();
    const reservadoEn = await correr();
    const despues = Date.now();

    const row = await registerStatus.getStatus(CUSTOMER);
    expect(row?.startedAt).toBeInstanceOf(Date);
    // El runner NO lo reescribe: es lo que el operador ve en el polling ("empezó a las…"), y
    // moverlo con cada latido del heartbeat le mentiría sobre cuándo arrancó el alta. Lo que se
    // renueva es `heartbeatAt`.
    expect(row!.startedAt!.getTime()).toBe(reservadoEn.getTime());
    expect(row!.startedAt!.getTime()).toBeGreaterThanOrEqual(antes);
    expect(row!.startedAt!.getTime()).toBeLessThanOrEqual(despues);
  });

  it('fallo: deja failed con el MENSAJE del error, que es lo único que el operador va a ver', async () => {
    const sim = new PartnerSim(['0000009001']);
    sim.fallosDeActivate = 1;
    const { registerStatus, correr } = await build({ sim });

    await correr();

    const row = await registerStatus.getStatus(CUSTOMER);
    expect(row?.status).toBe('failed');
    expect((row!.result as { error: string }).error).toMatch(/Gigared/i);
    // El startedAt sobrevive al fallo: sin él, el watchdog no puede fechar el job.
    expect(row?.startedAt).toBeInstanceOf(Date);
  });

  /**
   * El `code` del error de dominio también se persiste. Sin él, el polling degradaría lo que HOY
   * viaja por HTTP (NO_CIC_AVAILABLE, TV_POOL_POISONED, TV_EMAIL_OWNED_BY_OTHER…) a un string
   * suelto, y el FE perdería en silencio la capacidad de distinguir "el pool está envenenado,
   * llamá al admin" de "reintentá en unos segundos". Volver asíncrono el alta no puede costar eso.
   */
  it('fallo: persiste TAMBIÉN el code del error de dominio, no sólo el texto', async () => {
    const sim = new PartnerSim([]); // pool vacío → NoCicAvailableError
    const { registerStatus, correr } = await build({ sim });

    await correr();

    const row = await registerStatus.getStatus(CUSTOMER);
    expect(row?.status).toBe('failed');
    expect(row!.result as { code?: string }).toMatchObject({ code: 'NO_CIC_AVAILABLE' });
  });

  it('fallo sin code (Error pelado): persiste sólo el mensaje, sin inventar un code', async () => {
    const { registerStatus, correr } = await build({
      registerAccountStub: { execute: jest.fn(async () => { throw new Error('db down'); }) },
    });

    await correr();

    const row = await registerStatus.getStatus(CUSTOMER);
    expect(row!.result).toEqual({ error: 'db down' });
  });

  it('NUNCA lanza: el runner es fire-and-forget y un throw sería un unhandled rejection', async () => {
    const { registerStatus, correr } = await build({
      registerAccountStub: { execute: jest.fn(async () => { throw new Error('boom'); }) },
    });

    await expect(correr()).resolves.toBeInstanceOf(Date);
    expect((await registerStatus.getStatus(CUSTOMER))?.status).toBe('failed');
  });

  it('el reconcile local roto NO tumba el alta: done con localReconciled=failed', async () => {
    const { registerStatus, sim, correr } = await build({ romperReconcile: true });
    await correr();

    const row = await registerStatus.getStatus(CUSTOMER);
    expect(row?.status).toBe('done');
    expect((row!.result as TvRegisterJobResult).localReconciled).toBe('failed');
    expect(sim.cuentasCreadas).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// W3.3 — EL TEST CENTRAL DEL CHANGE: reintentar no puede quemar al cliente
// ---------------------------------------------------------------------------

describe('W3.3 — un job que falla DESPUÉS del register aceptado se reintenta SIN crear una segunda cuenta', () => {
  /**
   * El escenario EXACTO del incidente: `register` OK, `activate` 429. La cuenta ya existe en el
   * partner y el operador reintenta.
   *
   * ⚠️ El reintento SÍ vuelve a invocar el endpoint `register` (con otro cic del pool, porque el
   * cic quemado ya salió del pool `unregistered`), pero el partner lo RECHAZA por email duplicado
   * y ahí entra el discriminador por email, que reancla sobre la cuenta huérfana y reanuda desde
   * `activate`. Lo que NO puede pasar —y es lo que se mide— es que quede una SEGUNDA CUENTA.
   */
  it('activate 429 → reintento: UNA sola cuenta creada y el alta termina sobre el MISMO cic', async () => {
    const sim = new PartnerSim(['0000009001', '0000009002', '0000009003']);
    sim.fallosDeActivate = 1;
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    const { correr } = await build({ sim, registerStatus });

    // Intento 1 — muere en el activate, con la cuenta YA creada en el partner.
    await correr();
    expect((await registerStatus.getStatus(CUSTOMER))?.status).toBe('failed');
    expect(sim.cuentasCreadas).toBe(1);
    expect(sim.cuentas.get('0000009001')!.internalId).toBeNull(); // nunca se estampó

    // Intento 2 — el operador reintenta (es lo único que la UX le ofrece).
    const segundo = await build({ sim, registerStatus });
    await segundo.correr();

    const row = await registerStatus.getStatus(CUSTOMER);
    // PRESENCIA primero: el reintento tiene que HABER FUNCIONADO. Un test que sólo asertara
    // "no hay segunda cuenta" daría verde también si el reintento explotara sin tocar nada.
    expect(row?.status).toBe('done');
    expect((row!.result as TvRegisterJobResult).account.cic).toBe('0000009001');
    // Y AHORA la ausencia: el daño permanente es una segunda cuenta, no una segunda llamada.
    expect(sim.cuentasCreadas).toBe(1);
    expect(sim.cuentas.get('0000009002')!.registrada).toBe(false);
    expect(sim.cuentas.get('0000009001')!.internalId).toBe(CUSTOMER);
  });

  /**
   * Segundo modo de falla post-register: el stamp SÍ corrió y lo que falló fue el readback
   * (lag de replicación). Acá sí es el PROBE idempotente el que reancla, y el reintento no
   * invoca `register` NI UNA VEZ.
   */
  it('readback 404 tras el stamp → reintento: el probe reancla y NO se invoca register de nuevo', async () => {
    const sim = new PartnerSim(['0000009001', '0000009002']);
    sim.fallosDeReadback = 1;
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    const { correr } = await build({ sim, registerStatus });

    await correr();
    expect((await registerStatus.getStatus(CUSTOMER))?.status).toBe('failed');
    expect(sim.cuentas.get('0000009001')!.internalId).toBe(CUSTOMER); // el stamp SÍ persistió
    const registersTrasIntento1 = sim.registerCalls;
    expect(registersTrasIntento1).toBe(1);

    const segundo = await build({ sim, registerStatus });
    await segundo.correr();

    const row = await registerStatus.getStatus(CUSTOMER);
    expect(row?.status).toBe('done');
    expect((row!.result as TvRegisterJobResult).recovered).toBe(true);
    expect((row!.result as TvRegisterJobResult).account.cic).toBe('0000009001');
    // El probe cortocircuitó ANTES del pool: cero llamadas nuevas al register del partner.
    expect(sim.registerCalls).toBe(registersTrasIntento1);
    expect(sim.cuentasCreadas).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// W3.4 — el seq no avanza si el job falla
// ---------------------------------------------------------------------------

describe('W3.4 — el seq NO avanza cuando el job falla', () => {
  it('re-alta que falla: el seq queda donde estaba, así el reintento recomputa la MISMA identidad', async () => {
    const sim = new PartnerSim(['0000009001', '0000009002']);
    sim.fallosDeActivate = 1;
    const activation = new InMemoryClientTvActivationRepository();
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();

    const { correr } = await build({ sim, activation, registerStatus, reAlta: true });
    expect(await activation.getSeq(CUSTOMER)).toBe(0);

    await correr();

    expect((await registerStatus.getStatus(CUSTOMER))?.status).toBe('failed');
    // Si el seq hubiera avanzado a 1, el reintento mintearía `cust-1-1` —una identidad NUNCA
    // estampada— el probe fallaría y el discriminador por email tampoco encontraría nada
    // (el mail también lleva el seq) ⇒ SEGUNDO register real ⇒ cliente quemado.
    expect(await activation.getSeq(CUSTOMER)).toBe(0);
  });

  it('re-alta que falla y se reintenta: la MISMA identidad converge y el seq avanza recién al terminar', async () => {
    const sim = new PartnerSim(['0000009001', '0000009002', '0000009003']);
    sim.fallosDeActivate = 1;
    const activation = new InMemoryClientTvActivationRepository();
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();

    const primero = await build({ sim, activation, registerStatus, reAlta: true });
    await primero.correr();
    expect(sim.cuentasCreadas).toBe(1);

    const segundo = await build({ sim, activation, registerStatus, reAlta: true });
    await segundo.correr();

    const row = await registerStatus.getStatus(CUSTOMER);
    expect(row?.status).toBe('done');
    // La identidad estampada es la del seq 1 recomputado, NO una nueva del seq 2.
    expect(sim.cuentas.get('0000009001')!.internalId).toBe(`${CUSTOMER}-1`);
    expect(sim.cuentasCreadas).toBe(1);
    expect(await activation.getSeq(CUSTOMER)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// FIX WAVE — C2 (heartbeat), A2 (run no lanza), A3 (el éxito no muta a failed),
//            A4 (fencing del zombi), M3 (forense)
// ---------------------------------------------------------------------------

/** Un result válido de alta, para los stubs que no pasan por el use case real. */
const resultOk = () => ({
  account: { cic: '0000009001', gigaredId: '1001', email: 'x@y.com', firstName: 'N', lastName: 'A', registrationDate: '2026-08-11', services: [], internalId: CUSTOMER, clientId: CUSTOMER, ott: null },
  partnerCreated: true, localReconciled: 'synced', credentialsPersisted: true, recovered: false,
});

/** Deja correr el event loop (el runner arranca con `void`, no siempre se puede awaitear). */
const respirar = (ms = 0) => new Promise(r => setTimeout(r, ms));

describe('C2 — heartbeat: al job VIVO no se le roba el turno', () => {
  /**
   * EL BUG: `startedAt` se sellaba UNA vez y nunca se renovaba, así que el watchdog no podía
   * distinguir "el proceso murió" de "el job está tardando". Y el alta TARDA: 17 llamadas al
   * partner × 30 s de timeout = 510 s de piso, contra un TTL de 900 s. Los revisores lo midieron:
   * con el runner colgado DENTRO del register, el GET devolvía `expired` ("Podés reintentarla") y
   * un segundo POST daba 202. El sistema le PEDÍA al operador que disparara el segundo register —
   * que es exactamente lo que quemó a Calabria, Abello y Aceste.
   */
  it('mientras el alta avanza, el lease se renueva y el watchdog lo sigue viendo ACTIVO', async () => {
    let liberar!: () => void;
    const puerta = new Promise<void>(r => { liberar = r; });
    const { runner, registerStatus } = await build({
      heartbeatMs: 10,
      registerAccountStub: { execute: jest.fn(async () => { await puerta; return resultOk(); }) },
    });

    const reservadoEn = new Date();
    expect(await registerStatus.tryReserve(CUSTOMER, reservadoEn, TV_REGISTER_JOB_TTL_MS)).toBe(true);
    const corriendo = runner.run(CUSTOMER, input(), reservadoEn);

    await respirar(150); // ~15 latidos con el job todavía adentro del use case

    const row = await registerStatus.getStatus(CUSTOMER);
    expect(row?.status).toBe('running');
    // PRESENCIA: el sello se movió. Sin esto, la aserción de abajo sería verde también en un mundo
    // donde el heartbeat no existe pero el reloj no llegó a correr.
    expect(row!.heartbeatAt!.getTime()).toBeGreaterThan(reservadoEn.getTime());

    // El job lleva >100 ms VIVO. Con un TTL de 50 ms, medido contra el heartbeat sigue activo…
    expect(isTvRegisterJobActive(row, new Date(), 50)).toBe(true);
    // …y medido contra startedAt (lo que hacía el código viejo) estaría MUERTO. Ésta es la
    // diferencia exacta entre el bug y el arreglo.
    expect(Date.now() - row!.startedAt!.getTime()).toBeGreaterThan(50);
    expect(isTvRegisterJobActive({ ...row!, heartbeatAt: undefined }, new Date(), 50)).toBe(false);

    liberar();
    await corriendo;
    expect((await registerStatus.getStatus(CUSTOMER))?.status).toBe('done');
  });

  /**
   * Un blip de DB no puede costar el turno. Si un latido que falla matara el heartbeat, el job
   * seguiría vivo pero MUDO: a los 15 minutos el watchdog lo declara muerto, el GET dice "Podés
   * reintentarla" y volvemos al bug de arriba por la puerta de atrás. Por eso `escribir` distingue
   * "la DB falló" (reintentar en el próximo latido) de "el sello cambió" (somos un zombi, parar).
   */
  it('un blip de DB en un latido NO mata el heartbeat: el siguiente vuelve a renovar el lease', async () => {
    let liberar!: () => void;
    const puerta = new Promise<void>(r => { liberar = r; });
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    const original = registerStatus.compareAndSet.bind(registerStatus);
    let escriturasRunning = 0;
    jest.spyOn(registerStatus, 'compareAndSet').mockImplementation(async (id, esperado, row) => {
      if (row.status === 'running') {
        escriturasRunning++;
        // la 1ª es el claim (pasa); los dos latidos siguientes revientan.
        if (escriturasRunning === 2 || escriturasRunning === 3) throw new Error('db blip');
      }
      return original(id, esperado, row);
    });

    const { runner } = await build({
      registerStatus,
      heartbeatMs: 10,
      registerAccountStub: { execute: jest.fn(async () => { await puerta; return resultOk(); }) },
    });

    const reservadoEn = new Date();
    await registerStatus.tryReserve(CUSTOMER, reservadoEn, TV_REGISTER_JOB_TTL_MS);
    const corriendo = runner.run(CUSTOMER, input(), reservadoEn);
    await respirar(150);

    const row = await registerStatus.getStatus(CUSTOMER);
    expect(escriturasRunning).toBeGreaterThan(3); // PRESENCIA: hubo latidos DESPUÉS de los blips
    expect(row!.heartbeatAt!.getTime()).toBeGreaterThan(reservadoEn.getTime());
    expect(isTvRegisterJobActive(row, new Date(), 50)).toBe(true);

    liberar();
    await corriendo;
  });

  it('el heartbeat PARA cuando el job termina (no deja un timer latiendo para siempre)', async () => {
    const { registerStatus, correr } = await build({ heartbeatMs: 5 });
    await correr();

    const alTerminar = (await registerStatus.getStatus(CUSTOMER))!.heartbeatAt!.getTime();
    await respirar(60); // 12 latidos de margen si el timer siguiera vivo
    expect((await registerStatus.getStatus(CUSTOMER))!.heartbeatAt!.getTime()).toBe(alTerminar);
  });
});

describe('A2 — run() NO puede lanzar por ningún camino', () => {
  /**
   * El docstring decía "run NUNCA lanza" y era falso: el `setStatus('running')` estaba FUERA del
   * try, y los dos writes terminales podían rechazar. Tres caminos de rechazo confirmados. El test
   * que lo "cubría" usaba un repo in-memory que nunca rechaza — certificaba una promesa que el
   * código no cumplía.
   *
   * `run` se invoca con `void` (fire-and-forget): un throw es un unhandled rejection y en Node
   * moderno eso TUMBA EL PROCESO. Con el proceso caído, todos los jobs en curso quedan huérfanos.
   */
  class RepoQueSiempreFalla implements ClientTvRegisterStatusRepository {
    getStatus = jest.fn(async (): Promise<never> => { throw new Error('db down'); });
    tryReserve = jest.fn(async (): Promise<never> => { throw new Error('db down'); });
    compareAndSet = jest.fn(async (): Promise<never> => { throw new Error('db down'); });
  }

  it('el repo de estado rechaza en TODAS sus escrituras → run() resuelve igual', async () => {
    const repo = new RepoQueSiempreFalla();
    const runner = new RegisterTvJobRunner(
      { execute: jest.fn(async () => resultOk()) } as unknown as RegisterGigaredAccount,
      repo,
      5,
    );
    await expect(runner.run(CUSTOMER, input(), new Date())).resolves.toBeUndefined();
    expect(repo.compareAndSet).toHaveBeenCalled(); // PRESENCIA: sí intentó escribir
  });

  it('el use case explota Y el repo también → run() resuelve igual', async () => {
    const runner = new RegisterTvJobRunner(
      { execute: jest.fn(async () => { throw new Error('boom'); }) } as unknown as RegisterGigaredAccount,
      new RepoQueSiempreFalla(),
      5,
    );
    await expect(runner.run(CUSTOMER, input(), new Date())).resolves.toBeUndefined();
  });

  it('un heartbeat que rechaza no produce un unhandled rejection', async () => {
    const rechazos: unknown[] = [];
    const escucha = (e: unknown): void => { rechazos.push(e); };
    process.on('unhandledRejection', escucha);
    try {
      let liberar!: () => void;
      const puerta = new Promise<void>(r => { liberar = r; });
      const registerStatus = new InMemoryClientTvRegisterStatusRepository();
      const reservadoEn = new Date();
      await registerStatus.tryReserve(CUSTOMER, reservadoEn, TV_REGISTER_JOB_TTL_MS);
      jest.spyOn(registerStatus, 'compareAndSet').mockRejectedValue(new Error('db down'));
      const runner = new RegisterTvJobRunner(
        { execute: jest.fn(async () => { await puerta; return resultOk(); }) } as unknown as RegisterGigaredAccount,
        registerStatus,
        5,
      );
      const corriendo = runner.run(CUSTOMER, input(), reservadoEn);
      await respirar(60);
      liberar();
      await corriendo;
      await respirar(20);
    } finally {
      process.off('unhandledRejection', escucha);
    }
    expect(rechazos).toEqual([]);
  });

  /**
   * La red de última instancia. El propio MANEJO del error puede explotar: el runner lee `err.code`
   * para preservar la ramificación del FE, y eso es un acceso a una propiedad de un objeto que no
   * controlamos. Si ese acceso lanza, el throw sale del `catch` —donde ya no hay nadie— y sube como
   * unhandled rejection.
   *
   * Sin este test, el try/catch externo de `run()` sería una capa que ninguna mutación puede matar:
   * el blindaje de `escribir` la tapa en todos los demás caminos. Con él, cada capa tiene su propia
   * razón de existir y su propio contrafáctico.
   */
  it('hasta el MANEJO del error puede explotar: run() lo absorbe igual', async () => {
    const hostil = new Error('el partner rechazó');
    Object.defineProperty(hostil, 'code', { get() { throw new Error('getter roto'); } });

    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    const reservadoEn = new Date();
    await registerStatus.tryReserve(CUSTOMER, reservadoEn, TV_REGISTER_JOB_TTL_MS);
    const runner = new RegisterTvJobRunner(
      { execute: jest.fn(async () => { throw hostil; }) } as unknown as RegisterGigaredAccount,
      registerStatus,
      60_000,
    );

    await expect(runner.run(CUSTOMER, input(), reservadoEn)).resolves.toBeUndefined();
  });

  it('si el CLAIM del running falla, el alta NO se ejecuta (el partner no se toca)', async () => {
    // Abortar es el lado seguro: la fila queda en `pending`, el watchdog la expira y el operador
    // reintenta. Seguir adelante sin poder registrar el estado sería un alta a ciegas.
    const ejecutar = jest.fn(async () => resultOk());
    const runner = new RegisterTvJobRunner(
      { execute: ejecutar } as unknown as RegisterGigaredAccount,
      new RepoQueSiempreFalla(),
      5,
    );
    await runner.run(CUSTOMER, input(), new Date());
    expect(ejecutar).not.toHaveBeenCalled();
  });
});

describe('A3 — un alta EXITOSA no puede quedar persistida como failed', () => {
  /**
   * El `setStatus('done', result)` estaba DENTRO del try que envuelve al use case, así que un blip
   * de DB al persistir el ÉXITO caía en el catch y escribía `failed`. El operador ve un error de
   * NUESTRA base como si fuera del partner, con la cuenta YA creada, y reintenta.
   */
  it('la DB falla al escribir el done: NO se degrada a failed', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    const original = registerStatus.compareAndSet.bind(registerStatus);
    jest.spyOn(registerStatus, 'compareAndSet').mockImplementation(async (id, esperado, row) => {
      if (row.status === 'done') throw new Error('connection reset by peer');
      return original(id, esperado, row);
    });

    const { sim, correr } = await build({ registerStatus });
    await correr();

    // PRESENCIA: el alta SÍ se completó del lado del partner. Sin esto, "no quedó failed" sería
    // verde también en un mundo donde el alta nunca corrió.
    expect(sim.cuentasCreadas).toBe(1);

    const row = await registerStatus.getStatus(CUSTOMER);
    // LA aserción: un error de NUESTRA DB no puede disfrazarse de fallo del partner.
    expect(row?.status).not.toBe('failed');
    // Queda en running con el lease congelado → el watchdog lo expira y el reintento es idempotente.
    expect(row?.status).toBe('running');
  });
});

describe('A4 — fencing: un runner zombi no pisa el estado de la generación nueva', () => {
  /**
   * `jobId === customerId` y la escritura era un overwrite ciego, así que las dos generaciones eran
   * INDISTINGUIBLES. Un runner viejo que revive puede dejar `failed` con el alta OK (el operador
   * reintenta y quema al cliente) o `done` con el alta fallada.
   */
  it('otra generación reservó mientras el zombi corría → el zombi NO escribe', async () => {
    let liberar!: () => void;
    const puerta = new Promise<void>(r => { liberar = r; });
    const { runner, registerStatus } = await build({
      heartbeatMs: 60_000, // que no lata: acá se prueba el fence de la escritura TERMINAL
      registerAccountStub: { execute: jest.fn(async () => { await puerta; return resultOk(); }) },
    });

    const reservadoEn = new Date();
    await registerStatus.tryReserve(CUSTOMER, reservadoEn, TV_REGISTER_JOB_TTL_MS);
    const zombi = runner.run(CUSTOMER, input(), reservadoEn);
    await respirar(); // deja que haga el claim del running

    // Generación B: el watchdog dio por muerto al job y otro POST tomó la reserva.
    const nuevaReserva = new Date(Date.now() + 1_000);
    registerStatus.seedStatus(CUSTOMER, { status: 'pending', startedAt: nuevaReserva, heartbeatAt: nuevaReserva });

    liberar();
    await zombi;

    const row = await registerStatus.getStatus(CUSTOMER);
    expect(row?.status).toBe('pending');
    expect(row!.heartbeatAt!.getTime()).toBe(nuevaReserva.getTime());
  });

  it('el zombi tampoco escribe su FALLO sobre la generación nueva', async () => {
    let liberar!: () => void;
    const puerta = new Promise<void>(r => { liberar = r; });
    const { runner, registerStatus } = await build({
      heartbeatMs: 60_000,
      registerAccountStub: { execute: jest.fn(async () => { await puerta; throw new Error('429 del partner'); }) },
    });

    const reservadoEn = new Date();
    await registerStatus.tryReserve(CUSTOMER, reservadoEn, TV_REGISTER_JOB_TTL_MS);
    const zombi = runner.run(CUSTOMER, input(), reservadoEn);
    await respirar();

    const nuevaReserva = new Date(Date.now() + 1_000);
    registerStatus.seedStatus(CUSTOMER, { status: 'pending', startedAt: nuevaReserva, heartbeatAt: nuevaReserva });

    liberar();
    await zombi;

    expect((await registerStatus.getStatus(CUSTOMER))?.status).toBe('pending');
  });
});

describe('M3 — forense: lo que el estado NO publica queda en el log', () => {
  /**
   * El estado del job persiste sólo `error` + `code` — y así tiene que seguir siendo: hay un test
   * que PINEA que el polling no filtre `ownedByInternalId`, `poisonedCount`, `cic` ni `internalId`.
   * Pero ésos son los campos con los que se reconstruyó el incidente Centeno. La salida no es
   * publicarlos: es dejarlos en un log estructurado del servidor.
   */
  it('TV_EMAIL_OWNED_BY_OTHER: el log lleva ownedByInternalId; el estado NO', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { registerStatus, correr } = await build({
        registerAccountStub: {
          execute: jest.fn(async () => { throw new TvEmailOwnedByOtherError('c204382@x.com', 'cust-OTRO'); }),
        },
      });
      await correr();

      const linea = warn.mock.calls.find(c => String(c[0]).includes('[gigared]'));
      expect(linea).toBeDefined();
      expect(linea![1]).toMatchObject({
        customerId: CUSTOMER,
        code: 'TV_EMAIL_OWNED_BY_OTHER',
        ownedByInternalId: 'cust-OTRO',
        email: 'c204382@x.com',
      });

      // Y el contrato del polling no se toca: el estado sigue publicando SÓLO error + code.
      const row = await registerStatus.getStatus(CUSTOMER);
      expect(row!.result).toEqual({ error: expect.any(String), code: 'TV_EMAIL_OWNED_BY_OTHER' });
    } finally {
      warn.mockRestore();
    }
  });

  it('TV_POOL_POISONED: el log lleva poisonedCount', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { correr } = await build({
        registerAccountStub: { execute: jest.fn(async () => { throw new TvPoolPoisonedError(37); }) },
      });
      await correr();
      const linea = warn.mock.calls.find(c => String(c[0]).includes('[gigared]'));
      expect(linea![1]).toMatchObject({ code: 'TV_POOL_POISONED', poisonedCount: 37 });
    } finally {
      warn.mockRestore();
    }
  });

  it('TV_IDENTITY_UNVERIFIED: el log lleva cic + internalId', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { correr } = await build({
        registerAccountStub: {
          execute: jest.fn(async () => { throw new TvIdentityStampUnverifiedError('0000009853', 'cust-1-2'); }),
        },
      });
      await correr();
      const linea = warn.mock.calls.find(c => String(c[0]).includes('[gigared]'));
      expect(linea![1]).toMatchObject({ code: 'TV_IDENTITY_UNVERIFIED', cic: '0000009853', internalId: 'cust-1-2' });
    } finally {
      warn.mockRestore();
    }
  });
});
