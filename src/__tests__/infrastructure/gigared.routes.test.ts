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
import type { TvCredentials } from '@domain/ports/TvCredentialsReader';

import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import {
  GigaredAuthError, GigaredNotFoundError, GigaredRejectedError, GigaredUnavailableError,
  CicNotFoundError, CicAlreadyLinkedError,
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
function fakePort(over: Partial<GigaredPort> = {}): GigaredPort {
  return {
    getSummary: jest.fn(async () => ({ accounts: { registered: 1, unregistered: 2, total: 3 }, services: [] })),
    listAccounts: jest.fn(async () => [fakeAccount()]),
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
  /** #65 H3 — what the TV credentials reader returns for the customer (null = no TV row → 404). */
  tvCredentials?: TvCredentials | null;
  /** #72 — pre-seeded TV cancellation repo (if omitted, an empty one is created). */
  tvCancellation?: InMemoryClientTvCancellationRepository;
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
      (opts.contractExists === false ? null : { id, clientId: opts.contractOwner ?? 'cust-1' }),
  };

  // #72 — local TV-cancel flag repo (in-memory for tests). Caller may pass a pre-seeded one.
  const tvCancellation = opts.tvCancellation ?? new InMemoryClientTvCancellationRepository();

  const router = createGigaredRouter({
    getConfig: new GetGigaredConfig(cfg, flags),
    updateConfig: new UpdateGigaredConfig(cfg, flags),
    getSummary: new GetGigaredSummary(port),
    listAccounts: new ListGigaredAccounts(port),
    getCustomerAccount: new GetGigaredCustomerAccount(port, customerLookup, tvCancellation),
    linkCustomerToCic: new LinkCustomerToCic(port, customerLookup, contractLookup, csRepo, catalog, tvCancellation),
    registerAccount: new RegisterGigaredAccount(port, customerLookup, contractLookup, csRepo, catalog, tvCancellation),
    addTvService: new AddTvService(port, csRepo, catalog, contractLookup, customerLookup),
    removeTvService: new RemoveTvService(port, csRepo, catalog, contractLookup, customerLookup),
    setOttStatus: new SetOttStatus(port, customerLookup),
    cancelTv: new CancelTv(port, csRepo, catalog, contractLookup, customerLookup, tvCancellation),
    changeTvPassword: new ChangeTvPassword(port, customerLookup, contractLookup, csRepo, catalog),
    getTvCredentials: new GetTvCredentials(customerLookup, {
      getByCustomer: async () => (opts.tvCredentials === undefined ? { login: 'GIGA100', password: 'ip243200' } : opts.tvCredentials),
    }),
    requireRead: opts.perms?.read ?? pass,
    requireLink: opts.perms?.link ?? opts.perms?.write ?? pass,
    requireRegister: opts.perms?.register ?? opts.perms?.write ?? pass,
    requirePacks: opts.perms?.packs ?? opts.perms?.write ?? pass,
    requireOtt: opts.perms?.ott ?? opts.perms?.write ?? pass,
    requireCancel: opts.perms?.cancel ?? opts.perms?.write ?? pass,
    requireManage: opts.perms?.manage ?? pass,
    gigaredReady: createGigaredReadyMiddleware(cfg, flags),
    gigaredProbeReady: createGigaredReadyMiddleware(cfg, flags, { requireFlag: false }),
  });

  const app = express();
  app.use(express.json());
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
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234' });
    expect(res.status).not.toBe(403);
  });

  it('#65 default: POST /register sends sendActivationEmail=false (ficticio)', async () => {
    const port = fakePort();
    const app = await buildApp({ port });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234', password: 'ip243200' });
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
    const app = await buildApp();
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234', password: 'ip243200', sendActivationEmail: true });
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

describe('#47k POST /customers/:id/cancel — dar de baja TV', () => {
  it('happy (todo OK) → 200 { removed, failed:[], ottDisabled, local:"synced", localCancelled:true }', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ getAccountByInternalId });
    const app = await buildApp({ port, csRepo, catalog });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(200);
    expect(res.body.removed).toEqual(['129']);
    expect(res.body.failed).toEqual([]);
    expect(res.body.ottDisabled).toBe(true);
    expect(res.body.local).toBe('synced');
    // #64 — el body de la baja expone el renew (old/new CIC).
    expect(res.body.renew).toEqual({ oldCic: '0000000001', newCic: '0000000002' });
    // #72 — localCancelled: el flag local fue seteado. unlinked ya no existe.
    expect(res.body.localCancelled).toBe(true);
    expect(res.body.unlinked).toBeUndefined();
  });

  it('#64 renew falla → 207 { renew:null } (localCancelled aún true — renew es best-effort)', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const renewCic = jest.fn(async () => { throw new Error('renew upstream 500'); });
    const port = fakePort({ getAccountByInternalId, renewCic });
    const app = await buildApp({ port, csRepo, catalog });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(207);
    expect(res.body.renew).toBeNull();
    // #72 — el flag local se setea aunque el renew falle (renew es best-effort)
    expect(res.body.localCancelled).toBe(true);
  });

  it('cuenta sin vincular → 404 TV_NOT_LINKED', async () => {
    const port = fakePort({ getAccountByInternalId: jest.fn(async () => { throw new GigaredNotFoundError(); }) });
    const app = await buildApp({ port });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TV_NOT_LINKED');
  });

  it('contractId inválido → 404 CONTRACT_NOT_FOUND (antes de tocar Gigared)', async () => {
    const port = fakePort();
    const app = await buildApp({ port, contractExists: false });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'ghost' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
  });

  it('#47k HIGH: contractId de OTRO cliente → 404 CONTRACT_NOT_FOUND, Gigared intacto', async () => {
    const port = fakePort();
    // El contrato existe pero pertenece a 'cust-B': cust-1 NO puede cancelarlo.
    const app = await buildApp({ port, contractOwner: 'cust-B' });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C-of-B' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
    expect(port.removeService).not.toHaveBeenCalled();
    expect(port.setOtt).not.toHaveBeenCalled();
  });

  it('fallo parcial (un DELETE falla) → 207 { removed, failed }', async () => {
    const removeService = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('upstream 500'));
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [
        { id: '129', name: 'Gigared Play Full' },
        { id: '39', name: 'Pack Todo Futbol' },
      ] }))
      .mockResolvedValue(fakeAccount({ services: [{ id: '39', name: 'Pack Todo Futbol' }] }));
    const port = fakePort({ removeService, getAccountByInternalId });
    const app = await buildApp({ port });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(207);
    expect(res.body.removed).toEqual(['129']);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].id).toBe('39');
  });

  it('local reconcile falla → 207 { local:"failed" }', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ getAccountByInternalId });
    const app = await buildApp({ port, csRepo, catalog });
    // seed a managed row, then make update throw
    const cat = await catalog.getByName('TV');
    await csRepo.add({ contractId: 'C1', serviceCatalogId: cat!.id, notes: 'CIC 0000000001 · Gigared Play Full' });
    jest.spyOn(csRepo, 'update').mockRejectedValue(new Error('db down'));
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(207);
    expect(res.body.local).toBe('failed');
  });

  it('no tv.cancel → 403 (#50 granular)', async () => {
    const app = await buildApp({ perms: { cancel: deny } });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(403);
  });

  // ----- #64 fix wave: M2 207 criterion + H1 guard -----

  it('L1: #72 renew OK, packs removed, flag local seteado → 200 { localCancelled:true, renewAttempted:true }', async () => {
    // #72: setInternalId(newCic,'') ya no se llama — paso muerto eliminado.
    // El criterio 207 ya no incluye unlinked. Con todo exitoso → 200.
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ getAccountByInternalId });
    const app = await buildApp({ port, csRepo, catalog });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(200);
    expect(res.body.localCancelled).toBe(true);
    expect(res.body.renewAttempted).toBe(true);
  });

  // #74 — EL FIX: el OTT no cuenta para el veredicto cuando el renew tuvo éxito.
  // El paso OTT corre ANTES del renew, sobre el CIC VIEJO. Si el renew (posterior) reseteó la
  // cuenta (CIC nuevo, login viejo muerto), un ottDisabled=false es un dato pre-renew STALE: la
  // cuenta vieja ya no es accesible (403 cic-ownership LIVE) → la baja es COMPLETA. Caso real
  // 0006717800 → 0006283226. ANTES daba 207; ahora 200.
  it('#74 L3: OTT falla (setOtt throws) PERO renew OK → 200 (ottDisabled:false es moot post-renew)', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    const setOtt = jest.fn(async () => { throw new Error('ott upstream down'); });
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ setOtt, getAccountByInternalId });
    const app = await buildApp({ port, csRepo, catalog });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(200);
    expect(res.body.ottDisabled).toBe(false);
    // El renew reseteó la cuenta → la baja es efectiva pese al OTT pre-renew.
    expect(res.body.renew).toEqual({ oldCic: '0000000001', newCic: '0000000002' });
    expect(res.body.renewAttempted).toBe(true);
  });

  // #74 — OTT falla Y el renew falla → la cuenta vieja sigue viva con streaming → 207 (parcial real).
  it('#74: OTT falla + renew falla (renew:null) → 207 (cuenta vieja sigue viva)', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    const setOtt = jest.fn(async () => { throw new Error('ott upstream down'); });
    const renewCic = jest.fn(async () => { throw new Error('renew upstream 500'); });
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ setOtt, renewCic, getAccountByInternalId });
    const app = await buildApp({ port, csRepo, catalog });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(207);
    expect(res.body.ottDisabled).toBe(false);
    expect(res.body.renew).toBeNull();
  });

  // #74 — caso #5 de la tabla de verdad: NO había nada que renovar (renewAttempted=false) y el
  // OTT no se pudo apagar. Sin un renew que resetee la cuenta, el OTT viejo activo es un parcial
  // REAL → 207. El !ottDisabled SOLO cuenta cuando el renew NO reseteó la cuenta.
  it('#74: OTT falla + renewAttempted:false (cuenta ya pelada) → 207 (OTT viejo activo, sin renew que resetee)', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    const setOtt = jest.fn(async () => { throw new Error('ott upstream down'); });
    const renewCic = jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' }));
    // services:[] Y ott NO enabled → renewAttempted=false → renew no se intenta.
    const getAccountByInternalId = jest.fn(async () =>
      fakeAccount({
        services: [],
        ott: { id: 'ott-1', stationaryLicenses: 2, mobileLicenses: 1, registeredDevices: 0, status: 'disabled' },
      }),
    );
    const port = fakePort({ setOtt, renewCic, getAccountByInternalId });
    const app = await buildApp({ port, csRepo, catalog });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(207);
    expect(res.body.ottDisabled).toBe(false);
    expect(res.body.renewAttempted).toBe(false);
    expect(renewCic).not.toHaveBeenCalled();
  });

  it('#67 el caso real HONESTO: SOLO el pack base 129, DELETE → 424 "no se puede dar de baja"; el reconcile RELEE y el base SIGUE en la cuenta → la fila TV igual se inactiva + limpia → 200 { unremovable:[129], failed:[], renew, localCancelled:true, local:"synced" }', async () => {
    // Verificado LIVE 2026-06-12 (CIC 0006230159): el pack base es irremovible por política del CUA.
    // El error NO bloquea la baja: va a unremovable, el flujo renueva y setea el flag local → 200, NO 207.
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    const removeService = jest.fn(async () => {
      throw new GigaredUnavailableError('Gigared external service (CUA) error', 'El servicio seleccionado no se puede dar de baja');
    });
    // HONESTO: el base 129 nunca se borró (su DELETE lanzó). La relectura del reconcile lo sigue viendo.
    const getAccountByInternalId = jest.fn(async () =>
      fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }));
    const port = fakePort({ removeService, getAccountByInternalId });
    const app = await buildApp({ port, csRepo, catalog });
    // Fila TV viva con credenciales y notes del CIC viejo (lo que el reconcile excluyente debe inactivar).
    const cat = await catalog.getByName('TV');
    const row = await csRepo.add({
      contractId: 'C1', serviceCatalogId: cat!.id,
      notes: 'CIC 0000000001 · Gigared Play Full', tvLogin: 'GIGA129', tvPassword: 'old-secret',
    });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(200);
    expect(res.body.removed).toEqual([]);
    expect(res.body.failed).toEqual([]);
    expect(res.body.unremovable).toHaveLength(1);
    expect(res.body.unremovable[0].id).toBe('129');
    expect(res.body.renew).toEqual({ oldCic: '0000000001', newCic: '0000000002' });
    // #72 — localCancelled seteado; unlinked ya no existe.
    expect(res.body.localCancelled).toBe(true);
    expect(res.body.unlinked).toBeUndefined();
    // CRITICAL: el reconcile excluye el id irremovible → la fila local se inactiva + limpia (synced).
    expect(res.body.local).toBe('synced');
    const after = await csRepo.getById(row.id);
    expect(after!.status).toBe('inactive');
    expect(after!.tvLogin).toBeNull();
    expect(after!.tvPassword).toBeNull();
  });

  it('fully-peeled account (services:[], ott disabled) still resolves → renewAttempted:false → 200 (not permanent 207)', async () => {
    const csRepo = new InMemoryContractServiceRepository();
    const catalog = new InMemoryServiceCatalogRepository();
    const renewCic = jest.fn(async () => ({ oldCic: '0000000001', newCic: '0000000002' }));
    const getAccountByInternalId = jest.fn(async () =>
      fakeAccount({
        services: [],
        ott: { id: 'ott-1', stationaryLicenses: 2, mobileLicenses: 1, registeredDevices: 0, status: 'disabled' },
      }),
    );
    const port = fakePort({ renewCic, getAccountByInternalId });
    const app = await buildApp({ port, csRepo, catalog });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(200);
    expect(res.body.renewAttempted).toBe(false);
    expect(renewCic).not.toHaveBeenCalled();
  });
});

// #70 rework — la password del registro se GENERA SERVER-SIDE a partir del grClienteId
// del cliente (helper determinístico del #65: `ip{grClienteId}` paddeado a 8). El body del
// register YA NO acepta password: si viene, se ignora (strip silencioso para tolerar el FE
// viejo en la ventana de deploy). Sin grClienteId → 422 GR_CLIENT_ID_REQUIRED, Gigared intacto.
describe('#70 POST /register — password generada server-side (el body ya no la acepta)', () => {
  it('register SIN password en el body → 201 con la determinística ip{grClienteId} reenviada a Gigared', async () => {
    const register = jest.fn(async () => {});
    const app = await buildApp({ port: fakePort({ register }), grClienteId: '243200' });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234' });
    expect(res.status).toBe(201);
    expect(register).toHaveBeenCalledTimes(1);
    // ip243200 ya cumple la longitud mínima (8) → sin padding.
    expect((register.mock.calls[0] as unknown[])[0]).toMatchObject({ password: 'ip243200' });
  });

  it('grClienteId corto → la determinística se paddea a 8 (ip12 → ip120000)', async () => {
    const register = jest.fn(async () => {});
    const app = await buildApp({ port: fakePort({ register }), grClienteId: '12' });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234' });
    expect(res.status).toBe(201);
    expect((register.mock.calls[0] as unknown[])[0]).toMatchObject({ password: 'ip120000' });
  });

  it('body CON password → se IGNORA: se usa SIEMPRE la determinística (tolera FE viejo)', async () => {
    const register = jest.fn(async () => {});
    const app = await buildApp({ port: fakePort({ register }), grClienteId: '243200' });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234', password: 'otracosa99' });
    expect(res.status).toBe(201);
    expect(register).toHaveBeenCalledTimes(1);
    // la del body NO viaja; viaja la generada server-side.
    expect((register.mock.calls[0] as unknown[])[0]).toMatchObject({ password: 'ip243200' });
    expect((register.mock.calls[0] as unknown[])[0]).not.toMatchObject({ password: 'otracosa99' });
  });

  it('cliente SIN grClienteId → 422 GR_CLIENT_ID_REQUIRED, Gigared NUNCA tocado', async () => {
    const register = jest.fn(async () => {});
    const app = await buildApp({ port: fakePort({ register }), grClienteId: null });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GR_CLIENT_ID_REQUIRED');
    expect(res.body.error).toMatch(/Gestión Real/i);
    expect(register).not.toHaveBeenCalled();
  });

  it('e) the password NEVER appears in the endpoint response body', async () => {
    const app = await buildApp({ grClienteId: '243200' });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234' });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain('ip243200');
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
    });
    const app = await buildApp({ port });
    const res = await request(app)
      .post('/api/gigared/customers/cust-1/register')
      .send({ firstName: 'J', lastName: 'P', email: 'e@x.com', cic: '0000001234', password: 'ip243200', sendActivationEmail: true });
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

describe('#72 POST /customers/:id/cancel — anti-coining guard (routes)', () => {
  it('cancel en cliente ya dado de baja localmente → 404 TV_NOT_LINKED (sin tocar el partner)', async () => {
    const port = fakePort();
    const tvCancellation = new InMemoryClientTvCancellationRepository();
    tvCancellation.seedCancelled('cust-1');

    const app = await buildApp({ port, tvCancellation });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TV_NOT_LINKED');
    // Anti-coining: el partner no fue llamado
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
    expect(port.removeService).not.toHaveBeenCalled();
    expect(port.renewCic).not.toHaveBeenCalled();
  });
});
