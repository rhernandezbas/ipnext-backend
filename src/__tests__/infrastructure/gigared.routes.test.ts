/**
 * #47 — seam tests for gigared.routes (supertest + in-memory).
 * FROZEN wire contract statuses. Asserts:
 *  - 503 GIGARED_NOT_CONFIGURED when flag OFF and when key='' (all surface except /config)
 *  - /config GET/PUT accessible regardless of flag/key
 *  - GET /config body NEVER contains the full apiKey
 *  - 403 by verb (read/write/manage) via injected perm stubs
 *  - 207 end-to-end (gigared ok + csRepo fails) → { gigared:'ok', local:'failed' }
 *  - each domain error → its pinned status
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
import { CancelTvJobRunner } from '@infrastructure/scheduling/CancelTvJobRunner';
import { InMemoryTvActivationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository';
import { ListTvActivationHistory } from '@application/use-cases/gigared/ListTvActivationHistory';

import { GetGigaredConfig } from '@application/use-cases/gigared/GetGigaredConfig';
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
import type { TvCredentials } from '@domain/ports/TvCredentialsReader';

import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import {
  GigaredAuthError, GigaredNotFoundError, GigaredRejectedError, GigaredUnavailableError,
  CicNotFoundError, CicAlreadyLinkedError, NoCicAvailableError,
} from '@domain/errors/gigared';

const FLAG = 'gigared-integration';
const pass: RequestHandler = (_req, _res, next) => next();
const deny: RequestHandler = (_req, res) => { res.status(403).json({ error: 'forbidden', code: 'FORBIDDEN' }); };

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  const base: GigaredAccount = {
    cic: '0000000001', gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '2026-01-19', services: [{ id: '129', name: 'Gigared Play Full' }],
    internalId: 'cust-1', clientId: 'cust-1', ott: null,
  };
  const merged = { ...base, ...over };
  if (!('clientId' in over)) {
    merged.clientId = merged.internalId ? merged.internalId.replace(/-\d+$/, '') : null;
  }
  return merged;
}
/**
 * B2 (D2) — el register ahora hace un PROBE `getAccountByInternalId` ANTES del pool-pick
 * (idempotencia). El default de `fakePort()` resuelve SIEMPRE (lo consumen GetGigaredCustomerAccount/
 * LinkCustomerToCic/etc., que esperan éxito en la ÚNICA llamada que hacen) — no se puede tocar sin
 * romper esos describes. Los tests de POST /register que SÍ necesitan ejercitar el flujo COMPLETO
 * (register→activate→setInternalId) deben overridear `getAccountByInternalId` con este helper:
 * la 1ra llamada (el probe) 404ea (no hay nada estampado todavía) y las siguientes (el readback
 * post-stamp) resuelven al account final.
 */
function probeMissThenFound(final: GigaredAccount): jest.Mock {
  return jest.fn()
    .mockRejectedValueOnce(new GigaredNotFoundError())
    .mockResolvedValue(final);
}

function fakePort(over: Partial<GigaredPort> = {}): GigaredPort {
  return {
    getSummary: jest.fn(async () => ({ accounts: { registered: 1, unregistered: 2, total: 3 }, services: [] })),
    // B1 (D-pool): el pool DEFAULT debe ser LIMPIO (internalId: null) — de lo contrario el
    // anti-poison lo descarta y cualquier POST /register sin listAccounts override rompe con
    // TvPoolPoisonedError.
    listAccounts: jest.fn(async () => [fakeAccount({ internalId: null })]),
    getAccountByInternalId: jest.fn(async () => fakeAccount()),
    getAccountByCic: jest.fn(async () => fakeAccount({ internalId: '' })),
    register: jest.fn(async () => {}), activate: jest.fn(async () => {}), setInternalId: jest.fn(async () => {}),
    addService: jest.fn(async () => {}), removeService: jest.fn(async () => {}), setOtt: jest.fn(async () => {}),
    changePassword: jest.fn(async () => {}),
    renewCic: jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' })),
    ...over,
  };
}

interface Opts {
  port?: GigaredPort;
  flagOn?: boolean;
  apiKey?: string;
  perms?: {
    read?: RequestHandler;
    /** @deprecated use link/register/packs/ott/cancel instead — kept so old tests still compile */
    write?: RequestHandler;
    manage?: RequestHandler;
    link?: RequestHandler;
    register?: RequestHandler;
    packs?: RequestHandler;
    ott?: RequestHandler;
    cancel?: RequestHandler;
  };
  csRepo?: InMemoryContractServiceRepository;
  catalog?: InMemoryServiceCatalogRepository;
  contractExists?: boolean;
  customerExists?: boolean;
  /** #70 — grClienteId the customer lookup reports. Defaults to '243200' (a registerable client). */
  grClienteId?: string | null;
  /** Owner (clientId) the contract lookup reports. Defaults to 'cust-1' (the test customer). */
  contractOwner?: string;
  /**
   * #115 — grContratoId the contract lookup reports.
   * Defaults to '204382' (a CUA-valid grContratoId so the register can proceed).
   * Pass null to simulate a contract without grContratoId → 422 GR_CONTRACT_ID_REQUIRED.
   * Pass undefined to use the default.
   */
  grContratoId?: string | null;
  /** #65 H3 — what the TV credentials reader returns for the customer (null = no TV row → 404). */
  tvCredentials?: TvCredentials | null;
  /** #72 — pre-seeded TV cancellation repo (if omitted, an empty one is created). */
  tvCancellation?: InMemoryClientTvCancellationRepository;
  /** #131 PARTE B — tvEventRepo for AddTvService; when provided, reactivacion events are recorded. */
  tvEventRepo?: InMemoryTvActivationEventRepository;
  /** #131 PARTE B — inject req.user before the gigared router (simulates authenticated operator). */
  user?: { id: string; username: string };
}

async function buildApp(opts: Opts = {}) {
  const cfg = new InMemoryGigaredConfigRepository();
  await cfg.update({ apiKey: opts.apiKey ?? 'secret1234' });
  const flags = new InMemoryFeatureFlagRepository();
  flags.seed(FLAG, opts.flagOn ?? true);

  const port = opts.port ?? fakePort();
  const csRepo = opts.csRepo ?? new InMemoryContractServiceRepository();
  const catalog = opts.catalog ?? new InMemoryServiceCatalogRepository();
  const cat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (csRepo as any).catalog[cat.id] = { name: cat.name, label: cat.label };

  const customerLookup = {
    findById: async (id: string) =>
      opts.customerExists === false
        ? null
        : { id, grClienteId: opts.grClienteId === undefined ? '243200' : opts.grClienteId },
  };
  const contractLookup = {
    findById: async (id: string) =>
      opts.contractExists === false
        ? null
        : {
            id,
            clientId: opts.contractOwner ?? 'cust-1',
            grContratoId: opts.grContratoId === undefined ? '204382' : opts.grContratoId,
          },
  };

  // #72 — local TV-cancel flag repo (in-memory for tests). Caller may pass a pre-seeded one.
  const tvCancellation = opts.tvCancellation ?? new InMemoryClientTvCancellationRepository();
  // #10/#11 — async cancel status repo (in-memory for tests).
  const cancelStatus = new InMemoryClientTvCancelStatusRepository();

  const cancelTv = new CancelTv(port, csRepo, catalog, contractLookup, customerLookup, tvCancellation);
  const cancelTvRunner = new CancelTvJobRunner(cancelTv, cancelStatus);

  const router = createGigaredRouter({
    getConfig: new GetGigaredConfig(cfg, flags),
    updateConfig: new UpdateGigaredConfig(cfg, flags),
    getSummary: new GetGigaredSummary(port),
    listAccounts: new ListGigaredAccounts(port),
    getCustomerAccount: new GetGigaredCustomerAccount(port, customerLookup, tvCancellation),
    linkCustomerToCic: new LinkCustomerToCic(port, customerLookup, contractLookup, csRepo, catalog, tvCancellation),
    registerAccount: new RegisterGigaredAccount(port, customerLookup, contractLookup, csRepo, catalog, tvCancellation),
    addTvService: new AddTvService(port, csRepo, catalog, contractLookup, customerLookup, opts.tvEventRepo),
    removeTvService: new RemoveTvService(port, csRepo, catalog, contractLookup, customerLookup),
    setOttStatus: new SetOttStatus(port, customerLookup),
    cancelTv,
    changeTvPassword: new ChangeTvPassword(port, customerLookup, contractLookup, csRepo, catalog),
    getTvCredentials: new GetTvCredentials(customerLookup, {
      getByCustomer: async () => (opts.tvCredentials === undefined ? { login: 'GIGA100', password: 'ip243200' } : opts.tvCredentials),
    }),
    // service-transfer — wired with the same in-memory deps (dedicated seam tests live in
    // gigared.transfer.routes.test.ts; here it only satisfies the router contract).
    transferTv: new TransferTvToCustomer(port, customerLookup, contractLookup, csRepo, catalog, tvCancellation),
    requireRead: opts.perms?.read ?? pass,
    requireLink: opts.perms?.link ?? opts.perms?.write ?? pass,
    requireRegister: opts.perms?.register ?? opts.perms?.write ?? pass,
    requirePacks: opts.perms?.packs ?? opts.perms?.write ?? pass,
    requireOtt: opts.perms?.ott ?? opts.perms?.write ?? pass,
    requireCancel: opts.perms?.cancel ?? opts.perms?.write ?? pass,
    requireTransfer: pass,
    requireManage: opts.perms?.manage ?? pass,
    gigaredReady: createGigaredReadyMiddleware(cfg, flags),
    gigaredProbeReady: createGigaredReadyMiddleware(cfg, flags, { requireFlag: false }),
    cancelTvRunner,
    cancelStatus,
    customerLookup,
    contractLookup,
    listActivationHistory: new ListTvActivationHistory(new InMemoryTvActivationEventRepository()),
  });

  const app = express();
  app.use(express.json());
  // #131 PARTE B — inject req.user for tests that need an authenticated operator context.
  if (opts.user) {
    const injectedUser = opts.user;
    app.use((_req, _res, next) => { (_req as express.Request).user = { id: injectedUser.id, username: injectedUser.username, email: 'op@test.local' }; next(); });
  }
  app.use('/api/gigared', router);
  app.use(errorHandler);
  return app;
}

describe('gigared.routes — readiness/probe gating (#47 / M1)', () => {
  // M1 contract: API key is required ALWAYS; the flag gates everything EXCEPT /config and GET /summary.
  // GET /summary is the "probe / test connection" — usable with flag OFF as long as the key is set.

  it('M1: flag OFF + key set → GET /summary 200 (probe exempt from the flag)', async () => {
    const app = await buildApp({ flagOn: false, apiKey: 'secret1234' });
    const res = await request(app).get('/api/gigared/summary');
    expect(res.status).toBe(200);
    expect(res.body.accounts.total).toBe(3);
  });

  it('M1: flag OFF + NO key → GET /summary 503 (key required always)', async () => {
    const app = await buildApp({ flagOn: false, apiKey: '' });
    const res = await request(app).get('/api/gigared/summary');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('GIGARED_NOT_CONFIGURED');
  });

  it('M1: flag OFF + key set → mutation route 503 (flag gates non-probe routes)', async () => {
    const app = await buildApp({ flagOn: false, apiKey: 'secret1234' });
    const res = await request(app).post('/api/gigared/customers/cust-1/services').send({ serviceId: '129', contractId: 'C1' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('GIGARED_NOT_CONFIGURED');
  });

  it('M1: flag OFF + key set → non-probe read route (/accounts) 503', async () => {
    const app = await buildApp({ flagOn: false, apiKey: 'secret1234' });
    const res = await request(app).get('/api/gigared/accounts');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('GIGARED_NOT_CONFIGURED');
  });

  it("apiKey='' (flag ON) → 503 GIGARED_NOT_CONFIGURED on /accounts", async () => {
    const app = await buildApp({ apiKey: '', flagOn: true });
    const res = await request(app).get('/api/gigared/accounts');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('GIGARED_NOT_CONFIGURED');
  });

  it('GET /config accessible even when flag OFF (200, not 503)', async () => {
    const app = await buildApp({ flagOn: false });
    const res = await request(app).get('/api/gigared/config');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
  });

  it('PUT /config accessible when flag OFF', async () => {
    const app = await buildApp({ flagOn: false });
    const res = await request(app).put('/api/gigared/config').send({ baseUrl: 'https://x.example/api' });
    expect(res.status).toBe(200);
  });
});

describe('gigared.routes — config masking (#47)', () => {
  it('GET /config body NEVER contains the full apiKey', async () => {
    const app = await buildApp({ apiKey: 'supersecretKEY99' });
    const res = await request(app).get('/api/gigared/config');
    expect(res.status).toBe(200);
    expect(res.body.apiKeyLast4).toBe('EY99');
    expect(JSON.stringify(res.body)).not.toContain('supersecretKEY99');
    expect(res.body.apiKey).toBeUndefined();
  });

  it('PUT /config with bad baseUrl → 400 VALIDATION_ERROR', async () => {
    const app = await buildApp();
    const res = await request(app).put('/api/gigared/config').send({ baseUrl: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('gigared.routes — RBAC by verb (#47)', () => {
  it('no tv.read → 403 on /summary', async () => {
    const app = await buildApp({ perms: { read: deny } });
    const res = await request(app).get('/api/gigared/summary');
    expect(res.status).toBe(403);
  });

  it('no tv.packs → 403 on POST /services (#50 granular)', async () => {
    const app = await buildApp({ perms: { packs: deny } });
    const res = await request(app).post('/api/gigared/customers/cust-1/services').send({ serviceId: '129', contractId: 'C1' });
    expect(res.status).toBe(403);
  });

  it('no tv.manage → 403 on GET /config', async () => {
    const app = await buildApp({ perms: { manage: deny } });
    const res = await request(app).get('/api/gigared/config');
    expect(res.status).toBe(403);
  });
});

describe('gigared.routes — granular TV RBAC guards (#50)', () => {
  it('no tv.link → 403 on POST /customers/:id/link', async () => {
    const app = await buildApp({ perms: { link: deny } });
    const res = await request(app).post('/api/gigared/customers/cust-1/link').send({ cic: '0000001234' });
    expect(res.status).toBe(403);
  });

  it('tv.link allowed → passes guard (200 or domain result)', async () => {
    const app = await buildApp({ perms: { link: pass } });
    const res = await request(app).post('/api/gigared/customers/cust-1/link').send({ cic: '0000001234' });
    expect(res.status).not.toBe(403);
  });

  it('no tv.register → 403 on POST /customers/:id/register', async () => {
    const app = await buildApp({ perms: { register: deny } });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234' });
    expect(res.status).toBe(403);
  });

  it('tv.register allowed → passes guard', async () => {
    const app = await buildApp({ perms: { register: pass } });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      // #115 — contractId es requerido ahora; sin él la ruta devuelve 400 (no 403)
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234', contractId: 'C1' });
    expect(res.status).not.toBe(403);
  });

  it('#65 default: POST /register sends sendActivationEmail=false (ficticio)', async () => {
    const port = fakePort({ getAccountByInternalId: probeMissThenFound(fakeAccount()) });
    const app = await buildApp({ port });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      // #115 — contractId requerido
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234', password: 'ip243200', contractId: 'C1' });
    expect(res.status).toBe(201);
    const [, body] = (port.register as jest.Mock).mock.calls[0];
    expect((port.register as jest.Mock).mock.calls[0][0].sendActivationEmail).toBe(false);
    void body;
  });

  it('#65 no tv.register → 403 on POST /customers/:id/tv-password', async () => {
    const app = await buildApp({ perms: { register: deny } });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/tv-password')
      .send({ contractId: 'C1', password: 'ip243200' });
    expect(res.status).toBe(403);
  });

  it('#65 fix wave H1 — POST /tv-password OK → 200 + PATCHes with the ACCOUNT cic (cic NOT from body)', async () => {
    // The body sends a foreign cic; the server MUST ignore it and use the account's own cic.
    const port = fakePort({ getAccountByInternalId: jest.fn(async () => fakeAccount({ cic: '0000000001' })) });
    const app = await buildApp({ port, perms: { register: pass } });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/tv-password')
      .send({ cic: '9999999999', contractId: 'C1', password: 'ip243200' });
    expect(res.status).toBe(200);
    expect(res.body.password).toBe('ip243200');
    expect(typeof res.body.persisted).toBe('boolean');
    // The foreign cic from the body is NEVER used — only the resolved account cic.
    expect(port.changePassword).toHaveBeenCalledWith('0000000001', 'ip243200');
  });

  it('#65 fix wave H1 — POST /tv-password on an unlinked customer → 404 TV_NOT_LINKED', async () => {
    const port = fakePort({ getAccountByInternalId: jest.fn(async () => { throw new GigaredNotFoundError(); }) });
    const app = await buildApp({ port, perms: { register: pass } });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/tv-password')
      .send({ contractId: 'C1', password: 'ip243200' });
    expect(res.status).toBe(404);
    expect(port.changePassword).not.toHaveBeenCalled();
  });

  it('#65 POST /tv-password with a non-CUA password → 400 VALIDATION_ERROR (Gigared not touched)', async () => {
    const port = fakePort();
    const app = await buildApp({ port, perms: { register: pass } });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/tv-password')
      .send({ contractId: 'C1', password: 'ABC-123' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(port.changePassword).not.toHaveBeenCalled();
  });

  it('#65 POST /tv-password with a foreign contract → 404 CONTRACT_NOT_FOUND', async () => {
    const port = fakePort();
    const app = await buildApp({ port, perms: { register: pass }, contractOwner: 'cust-B' });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/tv-password')
      .send({ contractId: 'C-of-B', password: 'ip243200' });
    expect(res.status).toBe(404);
    expect(port.changePassword).not.toHaveBeenCalled();
  });

  it('#65 POST /tv-password without contractId → 400 VALIDATION_ERROR', async () => {
    const port = fakePort();
    const app = await buildApp({ port, perms: { register: pass } });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/tv-password')
      .send({ password: 'ip243200' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // #65 fix wave H3 — dedicated, guarded credentials surface.
  it('#65 H3 GET /tv-credentials OK → 200 { login, password } (guard tv.register)', async () => {
    const app = await buildApp({ perms: { register: pass }, tvCredentials: { login: 'GIGA2432', password: 'ip243200' } });
    const res = await request(app).get('/api/gigared/customers/cust-1/tv-credentials');
    expect(res.status).toBe(200);
    // #81 — el response gana `internalId` (identidad vigente; seq=0 → Client.id pelado).
    expect(res.body).toEqual({ login: 'GIGA2432', password: 'ip243200', internalId: 'cust-1' });
  });

  it('#65 H3 GET /tv-credentials WITHOUT tv.register → 403 (same guard as password change)', async () => {
    const app = await buildApp({ perms: { register: deny } });
    const res = await request(app).get('/api/gigared/customers/cust-1/tv-credentials');
    expect(res.status).toBe(403);
  });

  it('#65 H3 GET /tv-credentials with no TV row → 404 TV_NOT_LINKED', async () => {
    const app = await buildApp({ perms: { register: pass }, tvCredentials: null });
    const res = await request(app).get('/api/gigared/customers/cust-1/tv-credentials');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TV_NOT_LINKED');
  });

  it('no tv.packs → 403 on POST /customers/:id/services', async () => {
    const app = await buildApp({ perms: { packs: deny } });
    const res = await request(app).post('/api/gigared/customers/cust-1/services').send({ serviceId: '129', contractId: 'C1' });
    expect(res.status).toBe(403);
  });

  it('tv.packs allowed → passes guard on POST /services', async () => {
    const app = await buildApp({ perms: { packs: pass } });
    const res = await request(app).post('/api/gigared/customers/cust-1/services').send({ serviceId: '129', contractId: 'C1' });
    expect(res.status).not.toBe(403);
  });

  it('no tv.packs → 403 on DELETE /customers/:id/services/:serviceId', async () => {
    const app = await buildApp({ perms: { packs: deny } });
    const res = await request(app).delete('/api/gigared/customers/cust-1/services/129?contractId=C1');
    expect(res.status).toBe(403);
  });

  it('no tv.ott → 403 on PUT /customers/:id/ott', async () => {
    const app = await buildApp({ perms: { ott: deny } });
    const res = await request(app).put('/api/gigared/customers/cust-1/ott').send({ enabled: true });
    expect(res.status).toBe(403);
  });

  it('tv.ott allowed → passes guard', async () => {
    const app = await buildApp({ perms: { ott: pass } });
    const res = await request(app).put('/api/gigared/customers/cust-1/ott').send({ enabled: true });
    expect(res.status).not.toBe(403);
  });

  it('no tv.cancel → 403 on POST /customers/:id/cancel', async () => {
    const app = await buildApp({ perms: { cancel: deny } });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(403);
  });

  it('tv.cancel allowed → passes guard', async () => {
    const app = await buildApp({ perms: { cancel: pass } });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).not.toBe(403);
  });

  it('each granular guard is INDEPENDENT: tv.packs deny blocks /services but not /link', async () => {
    const app = await buildApp({ perms: { packs: deny, link: pass } });
    const packRes = await request(app).post('/api/gigared/customers/cust-1/services').send({ serviceId: '129', contractId: 'C1' });
    expect(packRes.status).toBe(403);
    const linkRes = await request(app).post('/api/gigared/customers/cust-1/link').send({ cic: '0000001234' });
    expect(linkRes.status).not.toBe(403);
  });
});

describe('gigared.routes — happy + 207 (#47)', () => {
  it('GET /summary → 200', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/gigared/summary');
    expect(res.status).toBe(200);
    expect(res.body.accounts.total).toBe(3);
  });

  it('GET /accounts → 200 { accounts }', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/gigared/accounts?email=e@x.com');
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
  });

  it('GET /customers/:id/account → 200 { linked, account }', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/gigared/customers/cust-1/account');
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(true);
    expect(res.body.account.cic).toBe('0000000001');
  });

  it('POST /services happy → 200', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/gigared/customers/cust-1/services').send({ serviceId: '129', contractId: 'C1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ gigared: 'ok', local: 'ok' });
  });

  it('POST /services with local failure → 207 { gigared:ok, local:failed }', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    jest.spyOn(csRepo, 'add').mockRejectedValue(new Error('db down'));
    const app = await buildApp({ csRepo });
    const res = await request(app).post('/api/gigared/customers/cust-1/services').send({ serviceId: '129', contractId: 'C1' });
    expect(res.status).toBe(207);
    expect(res.body).toMatchObject({ gigared: 'ok', local: 'failed' });
  });

  it('POST /register → 201', async () => {
    // B2 — probe (getAccountByInternalId) 404 primero para ejercitar el flujo COMPLETO
    // (register→activate→setInternalId), no la rama "recovered" del D2.
    const port = fakePort({ getAccountByInternalId: probeMissThenFound(fakeAccount()) });
    const app = await buildApp({ port });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      // #115 — contractId requerido
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234', password: 'ip243200', sendActivationEmail: true, contractId: 'C1' });
    expect(res.status).toBe(201);
    expect(res.body.account.cic).toBe('0000000001');
  });

  it('PUT /ott → 200 { ok:true }', async () => {
    const app = await buildApp();
    const res = await request(app).put('/api/gigared/customers/cust-1/ott').send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// #10/#11 — POST /cancel is now ASYNC (202). Detailed cancel scenarios (200/207 outcomes) are
// tested via CancelTvJobRunner unit tests and gigared.cancel-async.routes.test.ts.
// This describe block retains the pre-queue guard tests (404 errors that fire BEFORE queuing)
// and the RBAC guard, plus a smoke test confirming the 202 wire contract.
describe('#47k POST /customers/:id/cancel — async 202 (#10/#11)', () => {
  it('happy path -> 202 { status:"pending" } (async, does not block)', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'pending' });
  });

  it('contractId invalido -> 404 CONTRACT_NOT_FOUND (antes de encolar - fast check)', async () => {
    const port = fakePort();
    const app = await buildApp({ port, contractExists: false });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'ghost' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
  });

  it('#47k HIGH: contractId de OTRO cliente -> 404 CONTRACT_NOT_FOUND, Gigared intacto', async () => {
    const port = fakePort();
    const app = await buildApp({ port, contractOwner: 'cust-B' });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C-of-B' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
    expect(port.removeService).not.toHaveBeenCalled();
    expect(port.setOtt).not.toHaveBeenCalled();
  });

  it('no tv.cancel -> 403 (#50 granular)', async () => {
    const app = await buildApp({ perms: { cancel: deny } });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(403);
  });
});

// #70 / #115 — la password del registro se GENERA SERVER-SIDE a partir del grContratoId del
// contrato (#115, antes era grClienteId del cliente #70). El body del register YA NO acepta
// password: si viene, se ignora (strip silencioso para tolerar el FE viejo en la ventana de
// deploy). Sin grContratoId → 422 GR_CONTRACT_ID_REQUIRED, Gigared intacto.
describe('#70/#115 POST /register — password generada server-side desde grContratoId del contrato', () => {
  it('register SIN password en el body → 201 con la determinística ip{grContratoId} reenviada a Gigared', async () => {
    const register = jest.fn(async () => {});
    // grContratoId='204382' → password='ip204382' (8 chars, no padding needed)
    // B2 — probe 404 primero para ejercitar el flujo completo (no la rama "recovered").
    const app = await buildApp({ port: fakePort({ register, getAccountByInternalId: probeMissThenFound(fakeAccount()) }), grContratoId: '204382' });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234', contractId: 'C1' });
    expect(res.status).toBe(201);
    expect(register).toHaveBeenCalledTimes(1);
    // ip204382 ya cumple la longitud mínima (8) → sin padding.
    expect((register.mock.calls[0] as unknown[])[0]).toMatchObject({ password: 'ip204382' });
  });

  it('grContratoId corto → la determinística se paddea a 8 (ip12 → ip120000)', async () => {
    const register = jest.fn(async () => {});
    const app = await buildApp({ port: fakePort({ register, getAccountByInternalId: probeMissThenFound(fakeAccount()) }), grContratoId: '12' });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234', contractId: 'C1' });
    expect(res.status).toBe(201);
    expect((register.mock.calls[0] as unknown[])[0]).toMatchObject({ password: 'ip120000' });
  });

  it('body CON password → se IGNORA: se usa SIEMPRE la determinística desde el contrato (tolera FE viejo)', async () => {
    const register = jest.fn(async () => {});
    const app = await buildApp({ port: fakePort({ register, getAccountByInternalId: probeMissThenFound(fakeAccount()) }), grContratoId: '204382' });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234', password: 'otracosa99', contractId: 'C1' });
    expect(res.status).toBe(201);
    expect(register).toHaveBeenCalledTimes(1);
    // la del body NO viaja; viaja la generada server-side desde el grContratoId del contrato.
    expect((register.mock.calls[0] as unknown[])[0]).toMatchObject({ password: 'ip204382' });
    expect((register.mock.calls[0] as unknown[])[0]).not.toMatchObject({ password: 'otracosa99' });
  });

  it('contrato SIN grContratoId (null) → 422 GR_CONTRACT_ID_REQUIRED, Gigared NUNCA tocado', async () => {
    const register = jest.fn(async () => {});
    const app = await buildApp({ port: fakePort({ register }), grContratoId: null });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234', contractId: 'C1' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GR_CONTRACT_ID_REQUIRED');
    expect(res.body.error).toMatch(/Gestión Real/i);
    expect(register).not.toHaveBeenCalled();
  });

  it('e) the password NEVER appears in the endpoint response body', async () => {
    const app = await buildApp({ grContratoId: '204382' });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234', contractId: 'C1' });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain('ip204382');
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('password');
  });
});

describe('gigared.routes — domain error → status mapping (#47)', () => {
  it('GigaredAuthError → 502 GIGARED_AUTH_FAILED', async () => {
    const port = fakePort({ getSummary: jest.fn(async () => { throw new GigaredAuthError(); }) });
    const app = await buildApp({ port });
    const res = await request(app).get('/api/gigared/summary');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('GIGARED_AUTH_FAILED');
  });

  it('GigaredUnavailableError → 503 GIGARED_UNAVAILABLE', async () => {
    const port = fakePort({ getSummary: jest.fn(async () => { throw new GigaredUnavailableError(); }) });
    const app = await buildApp({ port });
    const res = await request(app).get('/api/gigared/summary');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('GIGARED_UNAVAILABLE');
  });

  it('#47g: GigaredUnavailableError with detail → 503 body carries detail (transparency)', async () => {
    const port = fakePort({
      register: jest.fn(async () => { throw new GigaredUnavailableError('Gigared API is unavailable', 'CUA no respondió a tiempo'); }),
      // B2 — probe 404 primero: si no, la cuenta "recovered" trivial esquivaría el register y
      // nunca llegaría a lanzar el GigaredUnavailableError que este test necesita observar.
      getAccountByInternalId: probeMissThenFound(fakeAccount()),
    });
    const app = await buildApp({ port });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      // #115 — contractId requerido
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234', password: 'ip243200', sendActivationEmail: true, contractId: 'C1' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('GIGARED_UNAVAILABLE');
    expect(res.body.detail).toBe('CUA no respondió a tiempo');
  });

  it('#47g: GigaredUnavailableError WITHOUT detail → 503 body has no detail key (no null noise)', async () => {
    const port = fakePort({ getSummary: jest.fn(async () => { throw new GigaredUnavailableError(); }) });
    const app = await buildApp({ port });
    const res = await request(app).get('/api/gigared/summary');
    expect(res.status).toBe(503);
    expect(res.body.detail).toBeUndefined();
  });

  it('#47g: GigaredAuthError with detail → 502 body carries detail (transparency)', async () => {
    const port = fakePort({ getSummary: jest.fn(async () => { throw new GigaredAuthError('Gigared API key is invalid', 'Clave de API inválida'); }) });
    const app = await buildApp({ port });
    const res = await request(app).get('/api/gigared/summary');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('GIGARED_AUTH_FAILED');
    expect(res.body.detail).toBe('Clave de API inválida');
  });

  it('GigaredNotFoundError on account lookup → 404 GIGARED_NOT_FOUND', async () => {
    const port = fakePort({ listAccounts: jest.fn(async () => { throw new GigaredNotFoundError(); }) });
    const app = await buildApp({ port });
    const res = await request(app).get('/api/gigared/accounts');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('GIGARED_NOT_FOUND');
  });

  it('GigaredRejectedError → 422 GIGARED_REJECTED with detail', async () => {
    const port = fakePort({ setOtt: jest.fn(async () => { throw new GigaredRejectedError('Bad', 'service rejected'); }) });
    const app = await buildApp({ port });
    const res = await request(app).put('/api/gigared/customers/cust-1/ott').send({ enabled: true });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GIGARED_REJECTED');
    expect(res.body.detail).toBe('service rejected');
  });

  it('unknown customer → 404 CLIENT_NOT_FOUND', async () => {
    const app = await buildApp({ customerExists: false });
    const res = await request(app).get('/api/gigared/customers/ghost/account');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CLIENT_NOT_FOUND');
  });

  it('unknown contract on add service → 404 CONTRACT_NOT_FOUND', async () => {
    const app = await buildApp({ contractExists: false });
    const res = await request(app).post('/api/gigared/customers/cust-1/services').send({ serviceId: '129', contractId: 'ghost' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
  });

  it('C2: CIC not found upstream on link → 404 CIC_NOT_FOUND (specific, not generic)', async () => {
    const port = fakePort({ getAccountByCic: jest.fn(async () => { throw new GigaredNotFoundError(); }) });
    const app = await buildApp({ port });
    const res = await request(app).post('/api/gigared/customers/cust-1/link').send({ cic: '0000009999' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CIC_NOT_FOUND');
  });

  it('C2: CIC linked to a different customer → 409 CIC_ALREADY_LINKED', async () => {
    const port = fakePort({ getAccountByCic: jest.fn(async () => fakeAccount({ internalId: 'cust-OTHER' })) });
    const app = await buildApp({ port });
    const res = await request(app).post('/api/gigared/customers/cust-1/link').send({ cic: '0000001234' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CIC_ALREADY_LINKED');
  });

  it('C2: link happy path (free CIC) → 200 with account', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/gigared/customers/cust-1/link').send({ cic: '0000001234' });
    expect(res.status).toBe(200);
    expect(res.body.account).toBeDefined();
  });

  it('47f: link with contractId + services → 200 { account, local:"synced" } and TV row reconciled', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    const port = fakePort({
      getAccountByCic: jest.fn(async () => fakeAccount({ internalId: '' })),
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ internalId: 'cust-1', services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });
    const app = await buildApp({ port, csRepo, catalog });
    const res = await request(app).post('/api/gigared/customers/cust-1/link').send({ cic: '0000001234', contractId: 'C1' });
    expect(res.status).toBe(200);
    expect(res.body.account).toBeDefined();
    expect(res.body.local).toBe('synced');
    const tvId = (await catalog.getByName('TV'))!.id;
    const row = await csRepo.getByPair('C1', tvId);
    expect(row!.notes).toBe('CIC 0000000001 · Gigared Play Full');
  });

  it('47f: link with invalid contractId → 404 CONTRACT_NOT_FOUND (before Gigared)', async () => {
    const port = fakePort();
    const app = await buildApp({ port, contractExists: false });
    const res = await request(app).post('/api/gigared/customers/cust-1/link').send({ cic: '0000001234', contractId: 'ghost' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
    expect(port.getAccountByCic).not.toHaveBeenCalled();
  });

  it('47f: link with contractId but local reconcile fails → 207 { local:"failed" }, link stays', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    jest.spyOn(csRepo, 'add').mockRejectedValue(new Error('db down'));
    const port = fakePort({
      getAccountByCic: jest.fn(async () => fakeAccount({ internalId: '' })),
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ internalId: 'cust-1', services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });
    const app = await buildApp({ port, csRepo, catalog });
    const res = await request(app).post('/api/gigared/customers/cust-1/link').send({ cic: '0000001234', contractId: 'C1' });
    expect(res.status).toBe(207);
    expect(res.body.local).toBe('failed');
    expect(port.setInternalId).toHaveBeenCalled();
  });

  it('47f: link WITHOUT contractId → 200 and no local field (back-compat)', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/gigared/customers/cust-1/link').send({ cic: '0000001234' });
    expect(res.status).toBe(200);
    expect(res.body.local).toBeUndefined();
  });

  // #4 — unhandled (raw/Prisma) error on link → structured 500 { error, code:'INTERNAL_ERROR' }
  // The route handler itself must send the structured response AND log via console.error with the
  // '[gigared] link: unhandled' prefix. Before the fix: handler called next(err) so the log came
  // from the generic errorHandler ('[UNHANDLED ERROR]'), not from the route. The test pins the
  // route-level logging as the distinguishing contract.
  it('#4: link — use case throws an unrecognized error → 500 { code:"INTERNAL_ERROR" } logged as "[gigared] link: unhandled"', async () => {
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const port = fakePort({
        getAccountByCic: jest.fn(async () => {
          // Simulates a raw/untyped error (e.g. Prisma or unexpected infrastructure failure)
          // that sendGigaredError does not recognise → returns false.
          const err = new Error('Unexpected database failure');
          (err as Error & { code?: string }).code = 'P2025'; // Prisma-style code
          throw err;
        }),
      });
      const app = await buildApp({ port });
      const res = await request(app).post('/api/gigared/customers/cust-1/link').send({ cic: '0000001234' });
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('INTERNAL_ERROR');
      expect(typeof res.body.error).toBe('string');
      expect(res.body.error.length).toBeGreaterThan(0);
      // The route handler must log with the gigared-specific prefix, NOT the generic errorHandler.
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('[gigared]'),
        expect.anything(),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  // #109 W1 — pool de CICs vacío en el register → 422 NO_CIC_AVAILABLE.
  // Verifica que sendGigaredError mapea NoCicAvailableError al status 422 correcto.
  it('#109 W1: POST /register con pool vacío → 422 NO_CIC_AVAILABLE', async () => {
    // listAccounts devuelve [] → use case lanza NoCicAvailableError → ruta debe responder 422.
    // B2 — probe 404 primero: si no, "recovered" trivial esquivaría el pool-pick por completo.
    const port = fakePort({
      listAccounts: jest.fn(async () => []),
      getAccountByInternalId: probeMissThenFound(fakeAccount()),
    });
    const app = await buildApp({ port });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      // #115 — contractId requerido
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', contractId: 'C1' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NO_CIC_AVAILABLE');
    // Gigared nunca debe recibir el register cuando el pool está vacío.
    expect(port.register).not.toHaveBeenCalled();
  });
});

// ----- #72: local TV-cancel flag integration (routes) -----

describe('#72 GET /customers/:id/account — local TV-cancel flag', () => {
  it('customer with tvCancelledAt seteado → { linked:false, account:null } SIN llamar al partner', async () => {
    const port = fakePort();
    // Pre-seed la cancelación local
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1');

    const app = await buildApp({ port, tvCancellation });
    const res = await request(app).get('/api/gigared/customers/cust-1/account');
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(false);
    expect(res.body.account).toBeNull();
    // El partner NO fue consultado
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
  });

  it('customer sin tvCancelledAt → llama al partner y retorna linked:true', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/gigared/customers/cust-1/account');
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(true);
  });
});

// #10/#11 — With async cancel, the anti-coining guard (tvCancelledAt) runs INSIDE the runner
// (background), not in the route. The route returns 202 immediately; the runner writes
// status:'failed' with the TvNotLinkedError. The FE polls GET /cancel/status to learn the outcome.
// This is covered end-to-end in gigared.cancel-async.routes.test.ts (runner unit tests).
describe('#72 POST /customers/:id/cancel — anti-coining (async — runner fails with TV_NOT_LINKED)', () => {
  it('cancel en cliente ya dado de baja localmente → 202 inicial (anti-coining guard now runs in runner, not route)', async () => {
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1');

    const app = await buildApp({ tvCancellation });
    // Route now returns 202 (queued) — the anti-coining check runs in the background runner.
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'pending' });
  });
});

// ---------------------------------------------------------------------------
// #115 — POST /register: contractId REQUERIDO + grContratoId + error mapping
// ---------------------------------------------------------------------------

describe('#115 POST /register — contractId requerido + identidad deriva del contrato', () => {
  it('sin contractId en el body → 400 VALIDATION_ERROR (Gigared no tocado)', async () => {
    const port = fakePort();
    const app = await buildApp({ port });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(port.register).not.toHaveBeenCalled();
  });

  it('contractId vacío ("") en el body → 400 VALIDATION_ERROR', async () => {
    const port = fakePort();
    const app = await buildApp({ port });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', contractId: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(port.register).not.toHaveBeenCalled();
  });

  it('contrato con grContratoId null → 422 GR_CONTRACT_ID_REQUIRED, Gigared no tocado', async () => {
    const port = fakePort();
    const app = await buildApp({ port, grContratoId: null });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', contractId: 'C1' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GR_CONTRACT_ID_REQUIRED');
    expect(port.register).not.toHaveBeenCalled();
  });

  it('contrato ajeno (contractOwner distinto) → 404 CONTRACT_NOT_FOUND, Gigared no tocado', async () => {
    const port = fakePort();
    const app = await buildApp({ port, contractOwner: 'cust-B' });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', contractId: 'C-of-B' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
    expect(port.register).not.toHaveBeenCalled();
  });

  it('happy path: contractId válido con grContratoId CUA-válido → 201', async () => {
    const app = await buildApp({ grContratoId: '204382' });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', contractId: 'C1' });
    expect(res.status).toBe(201);
    expect(res.body.account).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// B3 (D3) — 207 en POST /register, espejo exacto de link/addService. Result shape:
// { account, partnerCreated, localReconciled:'synced'|'failed', credentialsPersisted, recovered }.
// partial = !partnerCreated || localReconciled === 'failed' → 207; else 201.
// ---------------------------------------------------------------------------
describe('POST /customers/:id/register — 207 partial + result shape (B3, D3)', () => {
  it('happy path completo → 201 { partnerCreated:true, localReconciled:"synced", recovered:false }', async () => {
    const port = fakePort({ getAccountByInternalId: probeMissThenFound(fakeAccount()) });
    const app = await buildApp({ port });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', contractId: 'C1' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ partnerCreated: true, localReconciled: 'synced', recovered: false });
  });

  it('recovery mine-stamped con reconcile OK → 201 recovered:true (recovered NO gatea el status)', async () => {
    // seq=0 (sin tvCancellation seedeado) → internal_id vigente = 'cust-1' (pelado).
    const stamped = fakeAccount({ cic: '0000005555', internalId: 'cust-1' });
    const port = fakePort({ getAccountByInternalId: jest.fn(async () => stamped) });
    const app = await buildApp({ port });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', contractId: 'C1' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ partnerCreated: true, localReconciled: 'synced', recovered: true });
  });

  it('reconcile local falla → 207 { partnerCreated:true, localReconciled:"failed" }', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    jest.spyOn(csRepo, 'add').mockRejectedValue(new Error('db down'));
    const port = fakePort({ getAccountByInternalId: probeMissThenFound(fakeAccount()) });
    const app = await buildApp({ port, csRepo });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', contractId: 'C1' });
    expect(res.status).toBe(207);
    expect(res.body).toMatchObject({ partnerCreated: true, localReconciled: 'failed' });
  });

  it('TvPoolPoisonedError (B1) → 422 { code:"TV_POOL_POISONED", poisonedCount }', async () => {
    const port = fakePort({
      getAccountByInternalId: probeMissThenFound(fakeAccount()), // probe 404 -> sigue al pool-pick
      listAccounts: jest.fn(async () => [fakeAccount({ internalId: 'foreign-1' })]), // TODO envenenado
    });
    const app = await buildApp({ port });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', contractId: 'C1' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TV_POOL_POISONED');
    expect(res.body.poisonedCount).toBe(1);
  });

  it('TvIdentityStampUnverifiedError (B1) → 503 { code:"TV_IDENTITY_UNVERIFIED", cic, internalId }', async () => {
    const port = fakePort({
      listAccounts: jest.fn(async () => [fakeAccount({ cic: 'CLEANX', internalId: null })]),
      getAccountByInternalId: jest.fn()
        .mockRejectedValueOnce(new GigaredNotFoundError()) // probe: 404
        .mockResolvedValue(fakeAccount({ cic: 'OTHER-CIC' })), // post-stamp: mismatch
    });
    const app = await buildApp({ port });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', contractId: 'C1' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('TV_IDENTITY_UNVERIFIED');
    expect(res.body.cic).toBe('CLEANX');
    expect(res.body.internalId).toBe('cust-1');
  });

  it('TvEmailOwnedByOtherError (B2) → 409 { code:"TV_EMAIL_OWNED_BY_OTHER", email, ownedByInternalId }', async () => {
    const register = jest.fn(async () => { throw new GigaredRejectedError('Conflict', 'email already in use'); });
    const listAccounts = jest.fn(async (filter?: { status?: string; email?: string }) => {
      if (filter?.email) return [fakeAccount({ internalId: 'cust-OTHER' })];
      return [fakeAccount({ cic: 'POOLCIC', internalId: null })];
    });
    const port = fakePort({
      register, listAccounts,
      getAccountByInternalId: probeMissThenFound(fakeAccount()),
    });
    const app = await buildApp({ port });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', contractId: 'C1' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TV_EMAIL_OWNED_BY_OTHER');
    expect(res.body.ownedByInternalId).toBe('cust-OTHER');
  });
});

// ---------------------------------------------------------------------------
// #131 PARTE B — W2: seam test — actor threaded from req.user to tvEventRepo
// POST /customers/:id/services for a re-alta (inactive TV row) records 'reactivacion'
// with the operator's actorName. Verifies the route→use-case→reconcile→tvEventRepo seam.
// ---------------------------------------------------------------------------
describe('#131 W2 POST /services — actor seam: req.user.username threaded to tvEventRepo', () => {
  it('re-alta de servicio TV inactivo: registra evento "reactivacion" con actorName del operador', async () => {
    // Pre-condition: an existing inactive Gigared-managed TV row for contract C1.
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    const tvCat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (csRepo as any).catalog[tvCat.id] = { name: tvCat.name, label: tvCat.label };
    // Create the inactive Gigared-managed row (notes prefixed "CIC " marks it as Gigared-managed).
    const existingRow = await csRepo.add({ contractId: 'C1', serviceCatalogId: tvCat.id, notes: 'CIC 0000000001' });
    await csRepo.update(existingRow.id, { status: 'inactive' });

    // Gigared returns an account WITH a service → reconcile takes the "services present" branch
    // → wasInactive=true → records 'reactivacion'.
    const port = fakePort({
      addService: jest.fn(async () => {}),
      getAccountByInternalId: jest.fn(async () =>
        fakeAccount({ internalId: 'cust-1', services: [{ id: '129', name: 'Gigared Play Full' }] })),
    });

    const tvEventRepo = new InMemoryTvActivationEventRepository();

    // Build app with an authenticated operator injected via req.user.
    const app = await buildApp({
      port,
      csRepo,
      catalog,
      tvEventRepo,
      user: { id: 'op-007', username: 'operador.gonzalez' },
    });

    const res = await request(app)
      .post('/api/gigared/customers/cust-1/services')
      .send({ serviceId: '129', contractId: 'C1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ gigared: 'ok', local: 'ok' });

    // THE SEAM: the 'reactivacion' event must have been recorded with the operator's actorName.
    const events = tvEventRepo.all();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('reactivacion');
    // Ensures req.user.username was correctly threaded — not swapped with req.user.id and not empty.
    expect(events[0]!.actorName).toBe('operador.gonzalez');
    expect(events[0]!.actorId).toBe('op-007');
    expect(events[0]!.contractId).toBe('C1');
  });
});
