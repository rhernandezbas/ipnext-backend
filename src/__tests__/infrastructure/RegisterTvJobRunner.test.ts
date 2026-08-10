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
import { RegisterGigaredAccount } from '@application/use-cases/gigared/RegisterGigaredAccount';
import { InMemoryClientTvRegisterStatusRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvRegisterStatusRepository';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryClientTvCancellationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvCancellationRepository';
import { InMemoryClientTvActivationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvActivationRepository';
import { InMemoryTvActivationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository';
import { GigaredNotFoundError, GigaredRejectedError, GigaredUnavailableError } from '@domain/errors/gigared';
import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import type { TvRegisterJobResult } from '@domain/ports/ClientTvRegisterStatusRepository';

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

  const runner = new RegisterTvJobRunner(registerAccount, registerStatus);
  return { runner, registerStatus, sim, port, activation, tvCancellation, eventRepo };
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
    const { runner, registerStatus, sim } = await build();
    await runner.run(CUSTOMER, input());

    const row = await registerStatus.getStatus(CUSTOMER);
    expect(row?.status).toBe('done');
    const result = row!.result as TvRegisterJobResult;
    expect(result.partnerCreated).toBe(true);
    expect(result.account.cic).toBe('0000009001');
    expect(sim.cuentasCreadas).toBe(1);
  });

  it('pasa por running ANTES de terminar (la transición no se saltea)', async () => {
    const { runner, registerStatus } = await build();
    const vistos: string[] = [];
    const original = registerStatus.setStatus.bind(registerStatus);
    jest.spyOn(registerStatus, 'setStatus').mockImplementation(async (id, row) => {
      vistos.push(row.status);
      return original(id, row);
    });

    await runner.run(CUSTOMER, input());
    expect(vistos).toEqual(['running', 'done']);
  });

  it('sella startedAt al pasar a running (es el ancla del watchdog)', async () => {
    const { runner, registerStatus } = await build();
    const antes = Date.now();
    await runner.run(CUSTOMER, input());
    const despues = Date.now();

    const row = await registerStatus.getStatus(CUSTOMER);
    expect(row?.startedAt).toBeInstanceOf(Date);
    expect(row!.startedAt!.getTime()).toBeGreaterThanOrEqual(antes);
    expect(row!.startedAt!.getTime()).toBeLessThanOrEqual(despues);
  });

  it('fallo: deja failed con el MENSAJE del error, que es lo único que el operador va a ver', async () => {
    const sim = new PartnerSim(['0000009001']);
    sim.fallosDeActivate = 1;
    const { runner, registerStatus } = await build({ sim });

    await runner.run(CUSTOMER, input());

    const row = await registerStatus.getStatus(CUSTOMER);
    expect(row?.status).toBe('failed');
    expect((row!.result as { error: string }).error).toMatch(/Gigared/i);
    // El startedAt sobrevive al fallo: sin él, el watchdog no puede fechar el job.
    expect(row?.startedAt).toBeInstanceOf(Date);
  });

  it('NUNCA lanza: el runner es fire-and-forget y un throw sería un unhandled rejection', async () => {
    const registerAccount = { execute: jest.fn(async () => { throw new Error('boom'); }) } as unknown as RegisterGigaredAccount;
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    const runner = new RegisterTvJobRunner(registerAccount, registerStatus);

    await expect(runner.run(CUSTOMER, input())).resolves.toBeUndefined();
    expect((await registerStatus.getStatus(CUSTOMER))?.status).toBe('failed');
  });

  it('el reconcile local roto NO tumba el alta: done con localReconciled=failed', async () => {
    const { runner, registerStatus, sim } = await build({ romperReconcile: true });
    await runner.run(CUSTOMER, input());

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
    const { runner } = await build({ sim, registerStatus });

    // Intento 1 — muere en el activate, con la cuenta YA creada en el partner.
    await runner.run(CUSTOMER, input());
    expect((await registerStatus.getStatus(CUSTOMER))?.status).toBe('failed');
    expect(sim.cuentasCreadas).toBe(1);
    expect(sim.cuentas.get('0000009001')!.internalId).toBeNull(); // nunca se estampó

    // Intento 2 — el operador reintenta (es lo único que la UX le ofrece).
    const segundo = await build({ sim, registerStatus });
    await segundo.runner.run(CUSTOMER, input());

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
    const { runner } = await build({ sim, registerStatus });

    await runner.run(CUSTOMER, input());
    expect((await registerStatus.getStatus(CUSTOMER))?.status).toBe('failed');
    expect(sim.cuentas.get('0000009001')!.internalId).toBe(CUSTOMER); // el stamp SÍ persistió
    const registersTrasIntento1 = sim.registerCalls;
    expect(registersTrasIntento1).toBe(1);

    const segundo = await build({ sim, registerStatus });
    await segundo.runner.run(CUSTOMER, input());

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

    const { runner } = await build({ sim, activation, registerStatus, reAlta: true });
    expect(await activation.getSeq(CUSTOMER)).toBe(0);

    await runner.run(CUSTOMER, input());

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
    await primero.runner.run(CUSTOMER, input());
    expect(sim.cuentasCreadas).toBe(1);

    const segundo = await build({ sim, activation, registerStatus, reAlta: true });
    await segundo.runner.run(CUSTOMER, input());

    const row = await registerStatus.getStatus(CUSTOMER);
    expect(row?.status).toBe('done');
    // La identidad estampada es la del seq 1 recomputado, NO una nueva del seq 2.
    expect(sim.cuentas.get('0000009001')!.internalId).toBe(`${CUSTOMER}-1`);
    expect(sim.cuentasCreadas).toBe(1);
    expect(await activation.getSeq(CUSTOMER)).toBe(1);
  });
});
