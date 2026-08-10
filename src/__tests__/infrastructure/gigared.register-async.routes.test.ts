/**
 * gigared-alta-asincrona W2 — la ruta del alta pasa a ser ASÍNCRONA.
 *
 * Contrato de cable:
 *   POST /api/gigared/customers/:id/register → 202 { jobId, status:'pending' }
 *                                            → 409 { queued:false, reason:'already-running' }
 *                                            → 400/404/422 si el input es inválido (ANTES de encolar)
 *   GET  /api/gigared/customers/:id/register/status → 200 { status, message, startedAt?, result? }
 *
 * Por qué: un alta hace hasta 17 llamadas al partner, que corta a ~10 req/60 s. Con throttle
 * honesto el alta tarda 114 s en vacío y 361 s con 6 req/min de ruido — por encima del
 * requestTimeout de 300 s de Node. Cuando ese timeout corta el socket el handler sigue vivo, el
 * operador ve un error y reintenta: segundo register, cliente quemado.
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
  registerStatus?: InMemoryClientTvRegisterStatusRepository;
  customerExists?: boolean;
  contractExists?: boolean;
  contractOwner?: string;
  grContratoId?: string | null;
  perms?: { register?: RequestHandler };
}

async function buildApp(opts: Opts = {}) {
  const cfg = new InMemoryGigaredConfigRepository();
  await cfg.update({ apiKey: 'secret1234' });
  const flags = new InMemoryFeatureFlagRepository();
  flags.seed(FLAG, true);

  const port = opts.port ?? fakePort();
  const csRepo = new InMemoryContractServiceRepository();
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
  const registerTvRunner = new RegisterTvJobRunner(registerAccount, registerStatus);

  const router = createGigaredRouter({
    getConfig: new GetGigaredConfig(cfg, flags),
    updateConfig: new UpdateGigaredConfig(cfg, flags),
    getSummary: new GetGigaredSummary(port),
    listAccounts: new ListGigaredAccounts(port),
    getCustomerAccount: new GetGigaredCustomerAccount(port, customerLookup, tvCancellation),
    linkCustomerToCic: new LinkCustomerToCic(port, customerLookup, contractLookup, csRepo, catalog, tvCancellation),
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
  app.use('/api/gigared', router);
  app.use(errorHandler);
  return { app, port, registerStatus };
}

// ---------------------------------------------------------------------------
// W2.1 — 202 + { jobId }, sin tocar a Gigared en el request
// ---------------------------------------------------------------------------

describe('POST /customers/:id/register — 202 asíncrono (W2.1)', () => {
  it('happy path → 202 { jobId, status:"pending" }', async () => {
    const { app } = await buildApp();
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(202);
    // El job se direcciona por cliente: GET /customers/:id/register/status. El jobId ES ese id —
    // inventar un uuid que ningún endpoint acepta sería una afordancia falsa.
    expect(res.body).toEqual({ jobId: CUST, status: 'pending' });
  });

  it('deja el job en pending CON startedAt (el ancla del watchdog) antes de responder', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    // El runner se bloquea en su PRIMER write: así el estado observable es exactamente el que
    // dejó la RUTA, sin carreras con el trabajo de fondo.
    jest.spyOn(registerStatus, 'setStatus').mockImplementation(async function (this: unknown, id, row) {
      if (row.status === 'pending') { (registerStatus as unknown as { store: Map<string, unknown> }); }
      if (row.status !== 'pending') return new Promise<void>(() => {}); // cuelga al runner
      registerStatus.seedStatus(id, row);
    });

    const { app } = await buildApp({ registerStatus });
    await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);

    const row = await registerStatus.getStatus(CUST);
    expect(row?.status).toBe('pending');
    expect(row?.startedAt).toBeInstanceOf(Date);
  });

  /**
   * W2.1 literal: el request responde SIN haber llamado a Gigared ni una vez.
   * El runner queda colgado en su primer write, así que si alguna llamada al partner aparece,
   * salió del handler HTTP — que es justo lo que este change elimina.
   */
  it('el request responde sin haber tocado al partner NI UNA VEZ', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    jest.spyOn(registerStatus, 'setStatus').mockImplementation(async (id, row) => {
      if (row.status !== 'pending') return new Promise<void>(() => {});
      registerStatus.seedStatus(id, row);
    });
    const { app, port } = await buildApp({ registerStatus });

    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);

    expect(res.status).toBe(202);
    expect(llamadasAlPartner(port)).toBe(0);
  });

  /**
   * Y el complemento: aunque el partner NUNCA responda (el 429 + backoff real puede dejar una
   * llamada colgada minutos), el request igual termina. Con la ruta síncrona este test se colgaba
   * hasta el timeout de jest.
   */
  it('el partner colgado NO cuelga al request: 202 igual', async () => {
    const port = fakePort({ getAccountByInternalId: jest.fn(() => new Promise<GigaredAccount>(() => {})) });
    const { app } = await buildApp({ port });
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(202);
  });

  it('el runner corre en background y el job termina en done', async () => {
    const port = fakePort({
      getAccountByInternalId: jest.fn()
        .mockRejectedValueOnce(new GigaredNotFoundError())
        .mockResolvedValue(fakeAccount()),
    });
    const { app, registerStatus } = await buildApp({ port });
    await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    await new Promise(r => setTimeout(r, 200));
    expect((await registerStatus.getStatus(CUST))?.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// W2.2 — TODAS las validaciones siguen ANTES del 202
// ---------------------------------------------------------------------------

describe('POST /register — las validaciones corren ANTES de encolar (W2.2)', () => {
  it('sin contractId → 400 VALIDATION_ERROR, sin job encolado, Gigared intacto', async () => {
    const { app, port, registerStatus } = await buildApp();
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`)
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(llamadasAlPartner(port)).toBe(0);
    // Un input inválido NO puede quedar como un job que falla después: no se encola nada.
    expect(await registerStatus.getStatus(CUST)).toBeNull();
  });

  it('contractId vacío → 400 VALIDATION_ERROR, sin job encolado', async () => {
    const { app, registerStatus } = await buildApp();
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`)
      .send({ ...cuerpoValido, contractId: '' });
    expect(res.status).toBe(400);
    expect(await registerStatus.getStatus(CUST)).toBeNull();
  });

  it('cliente inexistente → 404 CLIENT_NOT_FOUND, sin job encolado', async () => {
    const { app, port, registerStatus } = await buildApp({ customerExists: false });
    const res = await request(app).post('/api/gigared/customers/ghost/register').send(cuerpoValido);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CLIENT_NOT_FOUND');
    expect(llamadasAlPartner(port)).toBe(0);
    expect(await registerStatus.getStatus('ghost')).toBeNull();
  });

  it('contrato inexistente → 404 CONTRACT_NOT_FOUND, sin job encolado', async () => {
    const { app, port, registerStatus } = await buildApp({ contractExists: false });
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
    expect(llamadasAlPartner(port)).toBe(0);
    expect(await registerStatus.getStatus(CUST)).toBeNull();
  });

  it('contrato de OTRO cliente → 404 CONTRACT_NOT_FOUND (ownership), sin job encolado', async () => {
    const { app, port, registerStatus } = await buildApp({ contractOwner: 'cust-B' });
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`)
      .send({ ...cuerpoValido, contractId: 'C-de-B' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
    expect(llamadasAlPartner(port)).toBe(0);
    expect(await registerStatus.getStatus(CUST)).toBeNull();
  });

  /**
   * El contrato sin grContratoId y el grContratoId que produce una password fuera de CUA son
   * chequeos 100% locales (una lectura del mirror). Si se dejaran caer dentro del job, el operador
   * pediría un alta, esperaría el polling y recién ahí vería un 422 que ya se sabía en el
   * milisegundo cero — exactamente el "input inválido convertido en job que falla después" que
   * W2.2 prohíbe.
   */
  it('contrato sin grContratoId → 422 GR_CONTRACT_ID_REQUIRED, sin job encolado', async () => {
    const { app, port, registerStatus } = await buildApp({ grContratoId: null });
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GR_CONTRACT_ID_REQUIRED');
    expect(llamadasAlPartner(port)).toBe(0);
    expect(await registerStatus.getStatus(CUST)).toBeNull();
  });

  it('grContratoId con caracteres fuera de CUA → 422 GR_CONTRACT_ID_REQUIRED, sin job encolado', async () => {
    const { app, registerStatus } = await buildApp({ grContratoId: 'A-B/C' });
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GR_CONTRACT_ID_REQUIRED');
    expect(await registerStatus.getStatus(CUST)).toBeNull();
  });

  it('sin permiso tv.register → 403 (el guard va antes que todo)', async () => {
    const { app, registerStatus } = await buildApp({ perms: { register: deny } });
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(403);
    expect(await registerStatus.getStatus(CUST)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// W2.3 — guard anti-doble-disparo (con watchdog)
// ---------------------------------------------------------------------------

describe('POST /register — guard anti-doble-disparo (W2.3)', () => {
  it('ya hay un alta running → 409 { queued:false, reason:"already-running" }', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    registerStatus.seedStatus(CUST, { status: 'running', startedAt: new Date() });
    const { app, port } = await buildApp({ registerStatus });

    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ queued: false, reason: 'already-running' });
    expect(llamadasAlPartner(port)).toBe(0);
  });

  it('ya hay un alta pending → 409 (no encola una segunda)', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    registerStatus.seedStatus(CUST, { status: 'pending', startedAt: new Date() });
    const { app } = await buildApp({ registerStatus });
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(409);
  });

  /**
   * W1.3 a través del seam HTTP — el agujero que CancelTvJobRunner tiene hoy. Un `running` cuyo
   * proceso murió NO puede bloquear al cliente para siempre.
   */
  it('running HUÉRFANO (más viejo que el TTL) → 202: el watchdog lo libera', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    registerStatus.seedStatus(CUST, {
      status: 'running',
      startedAt: new Date(Date.now() - (TV_REGISTER_JOB_TTL_MS + 60_000)),
    });
    const { app } = await buildApp({ registerStatus });

    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe(CUST);
  });

  it('done → 202 (re-encolable)', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    registerStatus.seedStatus(CUST, { status: 'done', startedAt: new Date() });
    const { app } = await buildApp({ registerStatus });
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(202);
  });

  it('failed → 202 (el reintento del operador es el caso de uso central)', async () => {
    const registerStatus = new InMemoryClientTvRegisterStatusRepository();
    registerStatus.seedStatus(CUST, { status: 'failed', result: { error: 'HTTP 429' }, startedAt: new Date() });
    const { app } = await buildApp({ registerStatus });
    const res = await request(app).post(`/api/gigared/customers/${CUST}/register`).send(cuerpoValido);
    expect(res.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// W2.4 — GET .../register/status
// ---------------------------------------------------------------------------

describe('GET /customers/:id/register/status (W2.4)', () => {
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
   * que el FE necesita para ramificar, y era lo que le llegaba por HTTP cuando el alta era
   * síncrona. Perderlo en la migración a asíncrono sería una regresión silenciosa.
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
