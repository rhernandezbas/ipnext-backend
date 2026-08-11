/**
 * POST /api/gigared/customers/:id/register — el alta de TV es SÍNCRONA.
 *
 * Contrato de cable:
 *   201 { account, partnerCreated, localReconciled, credentialsPersisted, recovered }
 *   207 idem, cuando el reconcile LOCAL falló (`localReconciled === 'failed'`)
 *   400 VALIDATION_ERROR / 404 CLIENT|CONTRACT_NOT_FOUND / 422 GR_CONTRACT_ID_REQUIRED
 *       — chequeos locales, TODOS antes de tocar al partner
 *
 * POR QUÉ volvió a ser síncrona (revert del contrato de gigared-alta-asincrona W2):
 * el 202 { jobId, status:'pending' } es un 2xx. El FE (ipnext-frontend/src/api/gigared.api.ts)
 * hace `const r = await api.post(...)` y devuelve `r.data` tipado como RegisterAccountResult;
 * axios NO lanza con un 2xx, así que la promesa RESUELVE y el operador ve un ALTA EXITOSA sobre
 * un job que recién arranca. Si ese job falla 30 s después, nadie se entera: el FE nunca fue
 * adaptado al polling. Un éxito falso es peor que un timeout — el timeout al menos se ve.
 *
 * Lo que NO volvió atrás: la infraestructura del job (RegisterTvJobRunner, el port/adapters del
 * estado, las columnas y el GET .../register/status que se sigue testeando más abajo) queda
 * INTACTA y cableada, esperando a la W5 del front.
 */
import request from 'supertest';
import express, { RequestHandler } from 'express';

import { createGigaredRouter, createGigaredReadyMiddleware } from '@infrastructure/http/routes/gigared.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';

import { InMemoryGigaredConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGigaredConfigRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryClientTvCancellationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvCancellationRepository';
import { InMemoryClientTvCancelStatusRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvCancelStatusRepository';
import { InMemoryClientTvRegisterStatusRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvRegisterStatusRepository';
import { InMemoryTvActivationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository';

import { GetGigaredConfig, GIGARED_FLAG } from '@application/use-cases/gigared/GetGigaredConfig';
import { UpdateGigaredConfig } from '@application/use-cases/gigared/UpdateGigaredConfig';
import { GetGigaredSummary } from '@application/use-cases/gigared/GetGigaredSummary';
import { ListGigaredAccounts } from '@application/use-cases/gigared/ListGigaredAccounts';
import { GetGigaredCustomerAccount } from '@application/use-cases/gigared/GetGigaredCustomerAccount';
import { LinkCustomerToCic } from '@application/use-cases/gigared/LinkCustomerToCic';
import { RegisterGigaredAccount } from '@application/use-cases/gigared/RegisterGigaredAccount';
import { AddTvService } from '@application/use-cases/gigared/AddTvService';
import { RemoveTvService } from '@application/use-cases/gigared/RemoveTvService';
import { SetOttStatus } from '@application/use-cases/gigared/SetOttStatus';
import { CancelTv } from '@application/use-cases/gigared/CancelTv';
import { ChangeTvPassword } from '@application/use-cases/gigared/ChangeTvPassword';
import { GetTvCredentials } from '@application/use-cases/gigared/GetTvCredentials';
import { TransferTvToCustomer } from '@application/use-cases/gigared/TransferTvToCustomer';
import { ListTvActivationHistory } from '@application/use-cases/gigared/ListTvActivationHistory';
import { CancelTvJobRunner } from '@infrastructure/scheduling/CancelTvJobRunner';
import { RegisterTvJobRunner } from '@infrastructure/scheduling/RegisterTvJobRunner';
import { TV_REGISTER_JOB_TTL_MS } from '@domain/gigared/tvRegisterJob';

import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import type { TvRegisterStatusRow } from '@domain/ports/ClientTvRegisterStatusRepository';
import { GigaredNotFoundError } from '@domain/errors/gigared';

const FLAG = GIGARED_FLAG;
const pass: RequestHandler = (_req, _res, next) => next();
const deny: RequestHandler = (_req, res) => { res.status(403).json({ error: 'forbidden' }); };

const CUST = 'cust-1';
const cuerpoValido = { firstName: 'J', lastName: 'P', email: 'e@x.com', contractId: 'C1' };

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  return {
    cic: '0000000001', gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '2026-01-19', services: [], internalId: CUST, clientId: CUST, ott: null,
    ...over,
  };
}

function fakePort(over: Partial<GigaredPort> = {}): GigaredPort {
  return {
    getSummary: jest.fn(async () => ({ accounts: { registered: 0, unregistered: 0, total: 0 }, services: [] })),
    listAccounts: jest.fn(async () => [fakeAccount({ internalId: null, clientId: null })]),
    getAccountByInternalId: jest.fn(async () => fakeAccount()),
    getAccountByCic: jest.fn(async () => fakeAccount({ internalId: null })),
    register: jest.fn(async () => {}),
    activate: jest.fn(async () => {}),
    setInternalId: jest.fn(async () => {}),
    addService: jest.fn(async () => {}),
    removeService: jest.fn(async () => {}),
    setOtt: jest.fn(async () => {}),
    changePassword: jest.fn(async () => {}),
    renewCic: jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' })),
    ...over,
  };
}

/** ¿Cuántas veces se tocó al partner, sumando TODOS los verbos del port? */
function llamadasAlPartner(port: GigaredPort): number {
  return Object.values(port as unknown as Record<string, jest.Mock>)
    .filter(v => typeof v === 'function' && 'mock' in v)
    .reduce((acc, fn) => acc + fn.mock.calls.length, 0);
}

interface Opts {
  port?: GigaredPort;
  csRepo?: InMemoryContractServiceRepository;
  registerStatus?: InMemoryClientTvRegisterStatusRepository;
  customerExists?: boolean;
  contractExists?: boolean;
  contractOwner?: string;
  grContratoId?: string | null;
  perms?: { register?: RequestHandler };
  /** Inyecta req.user (operador autenticado) antes del router. */
  user?: { id: string; username: string };
}

async function buildApp(opts: Opts = {}) {
  const cfg = new InMemoryGigaredConfigRepository();
  await cfg.update({ apiKey: 'secret1234' });
  const flags = new InMemoryFeatureFlagRepository();
  flags.seed(FLAG, true);

  const port = opts.port ?? fakePort();
  const csRepo = opts.csRepo ?? new InMemoryContractServiceRepository();
  const catalog = new InMemoryServiceCatalogRepository();
  const cat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (csRepo as any).catalog[cat.id] = { name: cat.name, label: cat.label };

  const customerLookup = {
    findById: async (id: string) =>
      opts.customerExists === false ? null : { id, grClienteId: '243200', name: 'PEREZ JUAN' },
  };
  const contractLookup = {
    findById: async (id: string) =>
      opts.contractExists === false
        ? null
        : { id, clientId: opts.contractOwner ?? CUST, grContratoId: opts.grContratoId === undefined ? '204382' : opts.grContratoId },
  };

  const tvCancellation = new InMemoryClientTvCancellationRepository();
  const cancelStatus = new InMemoryClientTvCancelStatusRepository();
  const registerStatus = opts.registerStatus ?? new InMemoryClientTvRegisterStatusRepository();
  const eventRepo = new InMemoryTvActivationEventRepository();

  const cancelTv = new CancelTv(port, csRepo, catalog, contractLookup, customerLookup, tvCancellation);
  const registerAccount = new RegisterGigaredAccount(
    port, customerLookup, contractLookup, csRepo, catalog, tvCancellation, undefined, eventRepo, () => 0,
  );
  // El runner sigue construido y cableado a propósito: la infraestructura del alta asíncrona no se
  // borró, sólo dejó de gobernar el contrato del POST. La W5 la vuelve a encender desde el FE.
  const registerTvRunner = new RegisterTvJobRunner(registerAccount, registerStatus);

  const router = createGigaredRouter({
    getConfig: new GetGigaredConfig(cfg, flags),
    updateConfig: new UpdateGigaredConfig(cfg, flags),
    getSummary: new GetGigaredSummary(port),
    listAccounts: new ListGigaredAccounts(port),
    getCustomerAccount: new GetGigaredCustomerAccount(port, customerLookup, tvCancellation),
    linkCustomerToCic: new LinkCustomerToCic(port, customerLookup, contractLookup, csRepo, catalog, tvCancellation),
    registerAccount,
    addTvService: new AddTvService(port, csRepo, catalog, contractLookup, customerLookup),
    removeTvService: new RemoveTvService(port, csRepo, catalog, contractLookup, customerLookup),
    setOttStatus: new SetOttStatus(port, customerLookup),
    cancelTv,
    changeTvPassword: new ChangeTvPassword(port, customerLookup, contractLookup, csRepo, catalog),
    getTvCredentials: new GetTvCredentials(customerLookup, { getByCustomer: async () => null }),
    transferTv: new TransferTvToCustomer(port, customerLookup, contractLookup, csRepo, catalog, tvCancellation),
    requireRead: pass,
    requireLink: pass,
    requireRegister: opts.perms?.register ?? pass,
    requirePacks: pass,
    requireOtt: pass,
    requireCancel: pass,
    requireTransfer: pass,
    requireManage: pass,
    gigaredReady: createGigaredReadyMiddleware(cfg, flags),
    gigaredProbeReady: createGigaredReadyMiddleware(cfg, flags, { requireFlag: false }),
    cancelTvRunner: new CancelTvJobRunner(cancelTv, cancelStatus),
    cancelStatus,
    registerTvRunner,
    registerStatus,
    customerLookup,
    contractLookup,
    listActivationHistory: new ListTvActivationHistory(eventRepo),
  });

  const app = express();
  app.use(express.json());
  if (opts.user) {
    const u = opts.user;
    app.use((req, _res, next) => { (req as express.Request).user = { id: u.id, username: u.username, email: 'op@test.local' }; next(); });
  }
  app.use('/api/gigared', router);
  app.use(errorHandler);
  return { app, port, registerStatus, eventRepo };
}

// ---------------------------------------------------------------------------
// El contrato: 201/207 CON el resultado, en el MISMO request
// ---------------------------------------------------------------------------

describe('POST /customers/:id/register — 201/207 con el resultado del alta', () => {
  it('happy path → 201 CON el resultado del alta en el body', async () => {
    const { app } = await buildApp();
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(201);
    expect(res.body.account).toBeDefined();
    expect(res.body).toMatchObject({ partnerCreated: true, localReconciled: 'synced' });
    // Y NO el sobre del job: si volviera { jobId, status:'pending' }, el FE lo resolvería como
    // éxito (axios no lanza con un 2xx) sobre un alta que todavía no pasó.
    expect(res.body.jobId).toBeUndefined();
    expect(res.body.status).toBeUndefined();
  });

  /**
   * LA aserción del revert. El 202 era un éxito FALSO: respondía antes de que el partner hubiera
   * sido tocado. Acá se mide lo contrario — cuando el 201 sale, el alta YA ocurrió.
   */
  it('el request ESPERA al alta: cuando responde, el partner ya fue llamado', async () => {
    // Probe 404 primero para ejercitar el flujo COMPLETO (register→activate→setInternalId) y no la
    // rama "recovered", donde el partner ya tenía la cuenta y `register` no se llama nunca.
    const port = fakePort({
      getAccountByInternalId: jest.fn()
        .mockRejectedValueOnce(new GigaredNotFoundError())
        .mockResolvedValue(fakeAccount()),
    });
    const { app } = await buildApp({ port });

    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(201);
    expect(llamadasAlPartner(port)).toBeGreaterThan(0);
    // El alta REAL contra el partner ya ocurrió cuando el 201 salió — no quedó nada en background.
    expect(port.register).toHaveBeenCalledTimes(1);
    expect(port.activate).toHaveBeenCalledTimes(1);
  });

  /**
   * El POST reserva el turno (guard anti-doble-disparo) y sella el desenlace en el MISMO request.
   * Lo que NO puede quedar es un `pending`/`running` colgado: sin nadie que lo cierre, el cliente
   * quedaría bloqueado por 409 durante los 15 min del TTL y el polling giraría sobre un job que ya
   * terminó.
   */
  it('cuando el POST responde, el estado del job ya es TERMINAL (nunca queda pending colgado)', async () => {
    const { app, registerStatus } = await buildApp();
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(201);

    const fila = await registerStatus.getStatus(CUST);
    expect(['done', 'failed']).toContain(fila?.status);
    const st = await request(app).get(`/api/gigared/customers/${CUST}/register/status`);
    expect(st.body.status).toBe('done');
  });

  /**
   * El 207 es el OTRO desenlace del contrato: el partner creó la cuenta pero el reconcile local
   * falló. Sigue siendo un 2xx con el resultado completo — el FE lo distingue por el status.
   */
  it('reconcile local falla → 207 con { partnerCreated:true, localReconciled:"failed" }', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    jest.spyOn(csRepo, 'add').mockRejectedValue(new Error('db down'));
    const port = fakePort({
      getAccountByInternalId: jest.fn()
        .mockRejectedValueOnce(new GigaredNotFoundError())
        .mockResolvedValue(fakeAccount()),
    });
    const { app } = await buildApp({ port, csRepo });

    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(207);
    expect(res.body).toMatchObject({ partnerCreated: true, localReconciled: 'failed' });
  });

  /**
   * El error del partner vuelve a viajar COMO STATUS HTTP del request, con los campos propios del
   * error de dominio. Con el 202 esto se degradaba a un `{ error, code }` dentro del job — y el FE,
   * que ni siquiera pollea, no veía NADA.
   */
  it('el alta falla en el partner → el error viaja en la MISMA respuesta (no en un job)', async () => {
    const port = fakePort({
      register: jest.fn(async () => { throw new GigaredNotFoundError('cuenta inexistente'); }),
      getAccountByInternalId: jest.fn()
        .mockRejectedValueOnce(new GigaredNotFoundError())
        .mockResolvedValue(fakeAccount()),
    });
    const { app } = await buildApp({ port });

    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    // Lo único que importa acá: NO es un 2xx. El FE actual ramifica por el throw de axios.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.code).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Validaciones LOCALES — siguen resolviéndose sin tocar al partner
// ---------------------------------------------------------------------------

describe('POST /register — las validaciones locales corren ANTES de tocar al partner', () => {
  it('sin contractId → 400 VALIDATION_ERROR, Gigared intacto', async () => {
    const { app, port } = await buildApp();
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`)
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(llamadasAlPartner(port)).toBe(0);
  });

  it('contractId vacío → 400 VALIDATION_ERROR', async () => {
    const { app, port } = await buildApp();
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`)
      .send({ ...cuerpoValido, contractId: '' });
    expect(res.status).toBe(400);
    expect(llamadasAlPartner(port)).toBe(0);
  });

  it('cliente inexistente → 404 CLIENT_NOT_FOUND, Gigared intacto', async () => {
    const { app, port } = await buildApp({ customerExists: false });
    const res = await request(app).post('/api/gigared/customers/ghost/register').send(cuerpoValido);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CLIENT_NOT_FOUND');
    expect(llamadasAlPartner(port)).toBe(0);
  });

  it('contrato inexistente → 404 CONTRACT_NOT_FOUND, Gigared intacto', async () => {
    const { app, port } = await buildApp({ contractExists: false });
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
    expect(llamadasAlPartner(port)).toBe(0);
  });

  /**
   * OWNERSHIP. Un operador no puede dar de alta la TV de un cliente usando el contrato de OTRO:
   * la identidad determinística de TV deriva del grContratoId, así que un contrato ajeno produce
   * credenciales del cliente equivocado. Se valida en la ruta, ANTES de cualquier llamada.
   */
  it('contrato de OTRO cliente → 404 CONTRACT_NOT_FOUND (ownership), Gigared intacto', async () => {
    const { app, port } = await buildApp({ contractOwner: 'cust-B' });
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`)
      .send({ ...cuerpoValido, contractId: 'C-de-B' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
    expect(llamadasAlPartner(port)).toBe(0);
  });

  /**
   * PRE-CHEQUEO del grContratoId: el contrato sin grContratoId, y el grContratoId que produce una
   * password fuera del alfabeto CUA, son chequeos 100% locales (una lectura del mirror). Se
   * resuelven en la ruta para que el partner NUNCA reciba un alta que ya se sabía inválida.
   */
  it('contrato sin grContratoId → 422 GR_CONTRACT_ID_REQUIRED, Gigared intacto', async () => {
    const { app, port } = await buildApp({ grContratoId: null });
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GR_CONTRACT_ID_REQUIRED');
    expect(llamadasAlPartner(port)).toBe(0);
  });

  it('grContratoId con caracteres fuera de CUA → 422 GR_CONTRACT_ID_REQUIRED, Gigared intacto', async () => {
    const { app, port } = await buildApp({ grContratoId: 'A-B/C' });
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GR_CONTRACT_ID_REQUIRED');
    expect(llamadasAlPartner(port)).toBe(0);
  });

  it('sin permiso tv.register → 403 (el guard va antes que todo)', async () => {
    const { app, port } = await buildApp({ perms: { register: deny } });
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(403);
    expect(llamadasAlPartner(port)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Guard anti-doble-disparo — RESERVA ATÓMICA, también con el alta síncrona
// ---------------------------------------------------------------------------

/**
 * El daño que este guard evita es PERMANENTE e irreversible: dos POST concurrentes producen DOS
 * `register` REALES contra el partner ⇒ dos activaciones pendientes ⇒ el cliente NO SE PUEDE DAR DE
 * ALTA NUNCA MÁS (Calabria, Abello, Aceste ya están quemados así). Con UNA sola réplica, un doble
 * click en el botón alcanza.
 *
 * Volver el alta a síncrona no cambia nada de eso: la ventana sigue abierta mientras el request
 * espera al partner —y ahora espera MINUTOS—, así que la reserva se mantiene. Lo que cambia es
 * quién la libera: ya no el runner desde el background, sino la propia ruta al terminar.
 */
describe('POST /register — guard anti-doble-disparo (reserva atómica)', () => {
  it('ya hay un alta running → 409 { queued:false, reason:"already-running" }, Gigared intacto', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    registerStatus.seedStatus(CUST, { status: 'running', startedAt: new Date(), heartbeatAt: new Date() });
    const { app, port } = await buildApp({ registerStatus });

    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ queued: false, reason: 'already-running' });
    expect(llamadasAlPartner(port)).toBe(0);
  });

  it('ya hay un alta pending → 409 (no dispara una segunda)', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    registerStatus.seedStatus(CUST, { status: 'pending', startedAt: new Date(), heartbeatAt: new Date() });
    const { app } = await buildApp({ registerStatus });
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(409);
  });

  /**
   * El WATCHDOG: un `running` cuyo proceso murió NO puede bloquear al cliente para siempre. Es el
   * agujero abierto de CancelTvJobRunner, que este camino no hereda.
   */
  it('running HUÉRFANO (más viejo que el TTL) → 201: el watchdog lo libera', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    const viejo = new Date(Date.now() - (TV_REGISTER_JOB_TTL_MS + 60_000));
    registerStatus.seedStatus(CUST, { status: 'running', startedAt: viejo, heartbeatAt: viejo });
    const { app } = await buildApp({ registerStatus });

    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(201);
  });

  it('done → 201 (re-encolable)', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    registerStatus.seedStatus(CUST, { status: 'done', startedAt: new Date(), heartbeatAt: new Date() });
    const { app } = await buildApp({ registerStatus });
    expect((await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido)).status).toBe(201);
  });

  it('failed → 201 (el reintento del operador es el caso de uso central)', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    registerStatus.seedStatus(CUST, { status: 'failed', result: { error: 'HTTP 429' }, startedAt: new Date(), heartbeatAt: new Date() });
    const { app } = await buildApp({ registerStatus });
    expect((await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido)).status).toBe(201);
  });
});

/**
 * Los cinco tests de arriba mandan UN SOLO request y siembran el estado con `seedStatus`: un
 * fixture DEGENERADO donde el invariante "un solo alta viva por cliente" no puede romperse ni
 * queriendo. El invariante REAL sólo se rompe con CONCURRENCIA — y ya nos mordió una vez: cinco
 * tests así daban verde sobre un guard con un TOCTOU adentro.
 */
describe('POST /register — la reserva es ATÓMICA (concurrencia real)', () => {
  /**
   * ⚠️ SIN ESTA CLASE NINGÚN TEST PUEDE EXHIBIR UN TOCTOU, y todo este describe sería teatro.
   *
   * Los fakes in-memory resuelven en MICROTASKS. Eso hace que cada handler de Express corra de
   * punta a punta dentro de un solo turno del event loop: el request B ni siquiera se empieza a
   * procesar hasta que A terminó. Con ese fixture, un `getStatus()` + decisión da el mismo
   * resultado que un compare-and-set y el race queda vivo SÓLO en producción, donde el port habla
   * con Postgres y cada llamada es I/O real.
   *
   * Esta clase reintroduce ese round-trip: cede al event loop ANTES de tocar el store. La sección
   * crítica del adapter (la decisión + la escritura) sigue siendo síncrona, que es justo lo que el
   * compare-and-set garantiza.
   */
  class RepoConLatenciaDeRed extends InMemoryClientTvRegisterStatusRepository {
    private pendientes: Array<() => void> = [];
    private disparada = false;
    private avisar!: () => void;
    /** Resuelve cuando los `esperados` requests ya se juntaron en la ventana de la reserva. */
    readonly juntados: Promise<void>;

    /** @param esperados cuántos requests concurrentes tienen que juntarse en la ventana. */
    constructor(private readonly esperados: number) {
      super();
      this.juntados = new Promise<void>(r => { this.avisar = r; });
    }

    /**
     * El round-trip. La PRIMERA vez es un rendezvous: los `esperados` primeros llamadores se juntan
     * y salen todos a la vez, así la ventana de carrera existe SIEMPRE y no depende de cómo el
     * sistema operativo haya ordenado los sockets ese día. Después degrada a un yield común (el
     * sellado del ganador tiene que poder seguir).
     */
    private viaje(): Promise<void> {
      if (this.disparada) return new Promise<void>(r => setImmediate(r));
      return new Promise<void>(r => {
        this.pendientes.push(r);
        if (this.pendientes.length >= this.esperados) {
          this.disparada = true;
          for (const seguir of this.pendientes.splice(0)) seguir();
          this.avisar();
        }
      });
    }

    override async getStatus(id: string) {
      await this.viaje();
      return super.getStatus(id);
    }
    override async tryReserve(id: string, startedAt: Date, ttlMs: number) {
      await this.viaje();
      return super.tryReserve(id, startedAt, ttlMs);
    }
    override async compareAndSet(id: string, esperado: Date, row: TvRegisterStatusRow) {
      await this.viaje();
      return super.compareAndSet(id, esperado, row);
    }
  }

  /**
   * Un pool con dos CICs libres (si el guard falla, cada alta agarra el suyo y quedan DOS altas
   * reales) y una PUERTA sobre la primera llamada al partner.
   *
   * La puerta no es decoración: sin ella el alta entera se resuelve en un puñado de microtasks —los
   * mocks no tienen I/O real— y el ganador termina y LIBERA la reserva antes de que el segundo
   * request llegue a pedirla. El estado ya sería terminal, el segundo POST reservaría legítimamente
   * y el test mediría cualquier cosa menos la concurrencia.
   */
  function escenarioConcurrente() {
    const register = jest.fn(async () => {});
    let abrir!: () => void;
    const puerta = new Promise<void>(r => { abrir = r; });
    const libre = (cic: string) =>
      fakeAccount({ cic, gigaredId: null, email: null, firstName: null, lastName: null, registrationDate: null, internalId: null, clientId: null });

    // El alta que GANA tiene que llegar hasta el 201, no morir en el readback: si el ganador
    // terminara en 503 el test seguiría "pasando" por el lado del 409 y dejaría de medir que el
    // alta buena se completa. Por eso el partner recuerda el CIC estampado y lo devuelve después.
    let cicEstampado: string | null = null;

    const port = fakePort({
      register,
      setInternalId: jest.fn(async (cic: string) => { cicEstampado = cic; }),
      // Primera llamada al partner del use case (el probe). Bloquea hasta `abrir()` y responde 404:
      // el cliente no tiene cuenta, así que el alta va al pool. Después del stamp, la MISMA función
      // es el readback de verificación y tiene que devolver la cuenta recién estampada.
      getAccountByInternalId: jest.fn(async () => {
        await puerta;
        if (cicEstampado === null) throw new GigaredNotFoundError();
        return fakeAccount({ cic: cicEstampado, internalId: CUST, clientId: CUST });
      }),
      listAccounts: jest.fn(async (filter?: { status?: string; email?: string }) => {
        if (filter?.email) return [];               // nadie tiene ese mail
        return [libre('0000009001'), libre('0000009002')];
      }),
    });
    return { port, register, abrir };
  }

  /**
   * Espera a que los N requests hayan pasado por la ventana de la reserva, con un TECHO.
   *
   * El rendezvous es lo que gobierna el camino verde: resuelve apenas los N llegaron, sin dormir
   * nada. El techo existe SÓLO para el contrafáctico: si alguien saca la reserva de la ruta, el
   * repo nunca se llama, `juntados` no resuelve NUNCA y la puerta del partner no se abriría jamás —
   * el test se colgaría hasta el timeout de jest en vez de fallar diciendo "dos register". Un test
   * que se cuelga no te dice qué se rompió; éste tiene que fallar mostrando el daño real.
   */
  async function esperarVentana(repo: RepoConLatenciaDeRed): Promise<void> {
    await Promise.race([repo.juntados, new Promise<void>(r => setTimeout(r, 200))]);
  }

  it('dos POST CONCURRENTES → 201 + 409 y UN SOLO register real contra el partner', async () => {
    const { port, register, abrir } = escenarioConcurrente();
    // El repo con latencia es lo que permite que los handlers se INTERCALEN (ver la clase).
    const registerStatus = new RepoConLatenciaDeRed(2);
    const { app } = await buildApp({ port, registerStatus });

    const disparo = () => request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    const enVuelo = Promise.all([disparo(), disparo()]);
    // Los dos ya pasaron por la ventana de la reserva. Recién ahí se deja avanzar al partner: sin
    // esto habría que dormir a ojo y el test pasaría o fallaría según la carga de la máquina.
    await esperarVentana(registerStatus);
    abrir();
    const [a, b] = await enVuelo;

    // PRESENCIA primero: uno de los dos TIENE que haber dado el alta. Un test que sólo asertara
    // "register se llamó una vez" daría verde también si los dos requests fallaran sin llamar.
    expect([a!.status, b!.status].sort()).toEqual([201, 409]);
    // LA aserción: el daño permanente se mide en llamadas REALES al partner, no en HTTP codes.
    // Contrafáctico verificado: con un read-then-decide en vez del compare-and-set, acá llegan DOS.
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('cinco POST concurrentes → exactamente un 201 y cuatro 409, y UN solo register', async () => {
    const { port, register, abrir } = escenarioConcurrente();
    const registerStatus = new RepoConLatenciaDeRed(5);
    const { app } = await buildApp({ port, registerStatus });

    const enVuelo = Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido)),
    );
    await esperarVentana(registerStatus);
    abrir();
    const res = await enVuelo;

    expect(res.filter(r => r.status === 201)).toHaveLength(1);
    expect(res.filter(r => r.status === 409)).toHaveLength(4);
    expect(register).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// La reserva se LIBERA al terminar — por los dos caminos
// ---------------------------------------------------------------------------

/**
 * Con el alta asíncrona el desenlace lo sellaba el runner. Ahora lo sella la ruta, y tiene que
 * hacerlo SIEMPRE: si un alta fallida dejara la reserva colgada, el cliente quedaría con 409
 * durante los 15 minutos del TTL — o sea, el guard que existe para protegerlo lo dejaría sin poder
 * reintentar justo cuando más lo necesita.
 */
describe('POST /register — la reserva se libera al terminar (sellado en el finally)', () => {
  it('tras un alta EXITOSA el cliente puede volver a operar (y el estado queda done)', async () => {
    const { app, registerStatus } = await buildApp();

    const primero = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(primero.status).toBe(201);
    expect((await registerStatus.getStatus(CUST))?.status).toBe('done');

    const segundo = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(segundo.status).not.toBe(409);
  });

  /**
   * EL camino que más importa: el operador reintenta justo después de un fallo. Si el `finally` no
   * sellara cuando el use case LANZA, éste sería el 409 que lo deja mirando la pantalla 15 minutos.
   */
  it('tras un alta FALLIDA el cliente puede REINTENTAR ya (y el estado queda failed con su code)', async () => {
    const port = fakePort({
      register: jest.fn(async () => { throw new GigaredNotFoundError('el partner rechazo el alta'); }),
      getAccountByInternalId: jest.fn()
        .mockRejectedValueOnce(new GigaredNotFoundError())
        .mockResolvedValue(fakeAccount()),
    });
    const { app, registerStatus } = await buildApp({ port });

    const primero = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(primero.status).toBeGreaterThanOrEqual(400);

    const fila = await registerStatus.getStatus(CUST);
    expect(fila?.status).toBe('failed');
    // El mismo shape que el runner persiste: el GET .../register/status lo publica sin traducirlo.
    expect((fila?.result as { error?: string })?.error).toBeDefined();

    const segundo = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(segundo.status).not.toBe(409);
  });

  /**
   * EL RESULTADO DEL ALTA MANDA SOBRE EL RESULTADO DEL SELLADO.
   *
   * Este bug ya apareció en este change del otro lado: con el `done` adentro del try, un blip de
   * nuestra DB al persistir el ÉXITO caía en el catch y escribía `failed` — el operador veía un
   * error de NUESTRA base como si fuera del partner, con la cuenta YA CREADA, y reintentaba. Acá el
   * sellado es best-effort puro: si falla, se loguea y no toca la respuesta.
   */
  it('si el SELLADO revienta, el alta exitosa sigue siendo un 201 (no se convierte en error)', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    jest.spyOn(registerStatus, 'compareAndSet').mockRejectedValue(new Error('db down al sellar'));
    const { app } = await buildApp({ registerStatus });

    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(201);
    expect(res.body.account).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GET .../register/status — la infraestructura del job QUEDA (W5)
// ---------------------------------------------------------------------------

/**
 * El endpoint de polling se mantiene EN PIE aunque el POST ya no encole: la W5 lo va a usar cuando
 * el FE sepa pollear. Como nadie encola desde HTTP, el estado se siembra directo en el repo — que
 * es exactamente lo que va a hacer el runner cuando se lo vuelva a enchufar.
 */
describe('GET /customers/:id/register/status — sigue en pie para la W5', () => {
  it('sin alta encolada nunca → 200 { status:"idle" }', async () => {
    const { app } = await buildApp();
    const res = await request(app).get(`/api/gigared/customers/${CUST}/register/status`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('idle');
    expect(res.body.message).toBeNull();
  });

  it('running → 200 { status:"running", message, startedAt ISO }', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    const startedAt = new Date(Date.now() - 5_000);
    registerStatus.seedStatus(CUST, { status: 'running', startedAt });
    const { app } = await buildApp({ registerStatus });

    const res = await request(app).get(`/api/gigared/customers/${CUST}/register/status`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
    expect(res.body.startedAt).toBe(startedAt.toISOString());
    expect(typeof res.body.message).toBe('string');
  });

  it('done → 200 con el result del alta', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    registerStatus.seedStatus(CUST, {
      status: 'done',
      startedAt: new Date(),
      result: { account: fakeAccount(), partnerCreated: true, localReconciled: 'synced', credentialsPersisted: true, recovered: false },
    });
    const { app } = await buildApp({ registerStatus });

    const res = await request(app).get(`/api/gigared/customers/${CUST}/register/status`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
    expect(res.body.result.account.cic).toBe('0000000001');
  });

  /**
   * Decisión de producto: el operador ve el error y ya. Entonces el mensaje del partner tiene que
   * llegar TAL CUAL — es lo único que le va a decir si conviene reintentar o llamar a Gigared.
   */
  it('failed → 200 { status:"failed", message: EL error del partner }', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    registerStatus.seedStatus(CUST, {
      status: 'failed',
      startedAt: new Date(),
      result: { error: 'Existe mas de una activacion pendiente' },
    });
    const { app } = await buildApp({ registerStatus });

    const res = await request(app).get(`/api/gigared/customers/${CUST}/register/status`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toBe('Existe mas de una activacion pendiente');
  });

  /**
   * El `code` del error de dominio sube al TOP del body, no sepultado dentro de `result`: es lo
   * que el FE necesita para ramificar.
   */
  it('failed → el code del error de dominio viaja en el top-level del body', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    registerStatus.seedStatus(CUST, {
      status: 'failed',
      startedAt: new Date(),
      result: { error: 'No hay ningún CIC disponible', code: 'NO_CIC_AVAILABLE' },
    });
    const { app } = await buildApp({ registerStatus });

    const res = await request(app).get(`/api/gigared/customers/${CUST}/register/status`);
    expect(res.body.status).toBe('failed');
    expect(res.body.code).toBe('NO_CIC_AVAILABLE');
  });

  it('done → no hay code (nada falló, no se inventa un campo)', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    registerStatus.seedStatus(CUST, {
      status: 'done',
      startedAt: new Date(),
      result: { account: fakeAccount(), partnerCreated: true, localReconciled: 'synced', credentialsPersisted: true, recovered: false },
    });
    const { app } = await buildApp({ registerStatus });

    const res = await request(app).get(`/api/gigared/customers/${CUST}/register/status`);
    expect(res.body.code).toBeUndefined();
  });

  /**
   * El watchdog TAMBIÉN se ve desde el polling. Si el GET siguiera diciendo 'running' sobre un job
   * muerto, el FE giraría para siempre: mismo bug, otra ventana.
   */
  it('running HUÉRFANO → 200 { status:"expired" } con mensaje accionable', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    registerStatus.seedStatus(CUST, {
      status: 'running',
      startedAt: new Date(Date.now() - (TV_REGISTER_JOB_TTL_MS + 1)),
    });
    const { app } = await buildApp({ registerStatus });

    const res = await request(app).get(`/api/gigared/customers/${CUST}/register/status`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('expired');
    expect(res.body.message).toMatch(/interrump/i);
  });

  it('cliente inexistente → 404 CLIENT_NOT_FOUND', async () => {
    const { app } = await buildApp({ customerExists: false });
    const res = await request(app).get('/api/gigared/customers/ghost/register/status');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CLIENT_NOT_FOUND');
  });

  it('mismo permiso que el alta: sin tv.register → 403', async () => {
    const { app } = await buildApp({ perms: { register: deny } });
    const res = await request(app).get(`/api/gigared/customers/${CUST}/register/status`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// M2 — seam del ACTOR: req.user → ruta → use case → historial
// ---------------------------------------------------------------------------

/**
 * El actor cruza tres saltos y ninguno estaba pinneado antes de la M2. Los revisores encontraron
 * una mutación que sobrevivía la suite entera: la ruta ignorando `req.user` (actor = {null,''}),
 * que deja el historial de TV con el alta registrada por NADIE — y ese historial es el rastro con
 * el que se auditan las altas. El seam va de punta a punta a propósito: cada salto testeado por
 * separado deja el pegamento sin cubrir, que es donde estaba el bug.
 */
describe('POST /register — el actor viaja de req.user hasta el historial de TV (M2)', () => {
  it('el evento "alta" queda con el actorName y el actorId del operador', async () => {
    const port = fakePort({
      // El probe falla la primera vez (el cliente no tiene cuenta) y resuelve después del stamp.
      getAccountByInternalId: jest.fn()
        .mockRejectedValueOnce(new GigaredNotFoundError())
        .mockResolvedValue(fakeAccount()),
    });
    const { app, eventRepo } = await buildApp({
      port,
      user: { id: 'op-007', username: 'operador.gonzalez' },
    });

    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(201);

    const eventos = eventRepo.all();
    // PRESENCIA: el alta tiene que HABER corrido. Sin esto, "el actorName no está vacío" sería
    // verde también en un mundo donde no se registró ningún evento.
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.eventType).toBe('alta');
    // Y el seam: ni swapeado con el id, ni vacío.
    expect(eventos[0]!.actorName).toBe('operador.gonzalez');
    expect(eventos[0]!.actorId).toBe('op-007');
  });

  it('sin operador autenticado el alta corre igual, con actor vacío (no revienta)', async () => {
    const port = fakePort({
      getAccountByInternalId: jest.fn()
        .mockRejectedValueOnce(new GigaredNotFoundError())
        .mockResolvedValue(fakeAccount()),
    });
    const { app, eventRepo } = await buildApp({ port });

    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(201);
    expect(eventRepo.all()).toHaveLength(1);
    expect(eventRepo.all()[0]!.actorName).toBe('');
  });
});
