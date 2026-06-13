/**
 * TDD tests for the async TV-cancel routes (#10/#11 BE side).
 *
 * Wire contract (FROZEN):
 *   POST /api/gigared/customers/:id/cancel → 202 { status:'pending' }
 *                                          → 409 { queued:false, reason:'already-running' } if running
 *   GET  /api/gigared/customers/:id/cancel/status → 200 { status, result?, startedAt? }
 *
 * Tests:
 *   Route POST cancel: → 202 {status:'pending'}; sets status pending; fires runner.
 *   Concurrent POST while running → 409 already-running.
 *   GET status: pending → {status:'pending'}; after runner done → {status:'done', result:{...}};
 *                         failed → {status:'failed', result:{error}}.
 *   Runner unit: running→done writes result; throw→failed writes error.
 *   Keep WT1 setOtt + WT2 date/clientId tests green (covered by gigared.routes.test.ts).
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
import { CancelTvJobRunner } from '@infrastructure/scheduling/CancelTvJobRunner';
import { InMemoryTvActivationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository';
import { ListTvActivationHistory } from '@application/use-cases/gigared/ListTvActivationHistory';

import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import type { TvCredentials } from '@domain/ports/TvCredentialsReader';
import type { CancelTvResult } from '@application/dto/gigared.dto';

const FLAG = GIGARED_FLAG;
const pass: RequestHandler = (_req, _res, next) => next();

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

interface Opts {
  port?: GigaredPort;
  flagOn?: boolean;
  apiKey?: string;
  cancelStatus?: InMemoryClientTvCancelStatusRepository;
  tvCancellation?: InMemoryClientTvCancellationRepository;
  csRepo?: InMemoryContractServiceRepository;
  catalog?: InMemoryServiceCatalogRepository;
  contractExists?: boolean;
  customerExists?: boolean;
  grClienteId?: string | null;
  contractOwner?: string;
  tvCredentials?: TvCredentials | null;
  /** If provided, the CancelTvJobRunner instance is accessible for assertions. */
  runnerRef?: { runner: CancelTvJobRunner | null };
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

  const tvCancellation = opts.tvCancellation ?? new InMemoryClientTvCancellationRepository();
  const cancelStatus = opts.cancelStatus ?? new InMemoryClientTvCancelStatusRepository();

  const cancelTv = new CancelTv(port, csRepo, catalog, contractLookup, customerLookup, tvCancellation);
  const runner = new CancelTvJobRunner(cancelTv, cancelStatus);
  if (opts.runnerRef) opts.runnerRef.runner = runner;

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
    cancelTv,
    changeTvPassword: new ChangeTvPassword(port, customerLookup, contractLookup, csRepo, catalog),
    getTvCredentials: new GetTvCredentials(customerLookup, {
      getByCustomer: async () => (opts.tvCredentials === undefined ? { login: 'GIGA100', password: 'ip243200' } : opts.tvCredentials),
    }),
    requireRead: pass,
    requireLink: pass,
    requireRegister: pass,
    requirePacks: pass,
    requireOtt: pass,
    requireCancel: pass,
    requireManage: pass,
    gigaredReady: createGigaredReadyMiddleware(cfg, flags),
    gigaredProbeReady: createGigaredReadyMiddleware(cfg, flags, { requireFlag: false }),
    cancelTvRunner: runner,
    cancelStatus,
    customerLookup,
    contractLookup,
    listActivationHistory: new ListTvActivationHistory(new InMemoryTvActivationEventRepository()),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/gigared', router);
  app.use(errorHandler);
  return { app, runner, cancelStatus };
}

// ---------------------------------------------------------------------------
// POST /customers/:id/cancel — async (202) wire contract
// ---------------------------------------------------------------------------

describe('POST /customers/:id/cancel — async 202 wire contract (#10/#11 BE)', () => {
  it('happy path → 202 { status:"pending" } immediately (does not await runner)', async () => {
    // The runner takes time; the route must return 202 synchronously before runner completes.
    const port = fakePort({
      getAccountByInternalId: jest.fn(async () => {
        // slow runner — route should not wait for this
        await new Promise(resolve => setTimeout(resolve, 50));
        return fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] });
      }),
    });
    const { app } = await buildApp({ port });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'pending' });
  });

  it('sets tvCancelStatus=pending in cancelStatus repo before returning 202', async () => {
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    const { app } = await buildApp({ cancelStatus });
    await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    const statusRow = await cancelStatus.getStatus('cust-1');
    // Must be pending or running/done (runner may have started) — at minimum not null
    expect(statusRow).not.toBeNull();
    expect(['pending', 'running', 'done', 'failed']).toContain(statusRow?.status);
  });

  it('fires the runner in the background (runner eventually writes done/failed)', async () => {
    const getAccountByInternalId = jest.fn()
      .mockResolvedValueOnce(fakeAccount({ services: [{ id: '129', name: 'Gigared Play Full' }] }))
      .mockResolvedValue(fakeAccount({ services: [] }));
    const port = fakePort({ getAccountByInternalId });
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    const { app } = await buildApp({ port, cancelStatus });
    await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    // Wait for the background runner to complete
    await new Promise(resolve => setTimeout(resolve, 200));
    const statusRow = await cancelStatus.getStatus('cust-1');
    expect(statusRow?.status).toBe('done');
    expect(statusRow?.result).toBeDefined();
  });

  it('unknown customer → 404 CLIENT_NOT_FOUND (fast check before queuing)', async () => {
    const { app } = await buildApp({ customerExists: false });
    const res = await request(app).post('/api/gigared/customers/ghost/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CLIENT_NOT_FOUND');
  });

  it('contractId of another customer → 404 CONTRACT_NOT_FOUND (fast check before queuing)', async () => {
    const port = fakePort();
    const { app } = await buildApp({ port, contractOwner: 'cust-B' });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C-of-B' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
  });

  it('contractId not found → 404 CONTRACT_NOT_FOUND (fast check before queuing)', async () => {
    const port = fakePort();
    const { app } = await buildApp({ port, contractExists: false });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'ghost' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Concurrent POST while running → 409
// ---------------------------------------------------------------------------

describe('POST cancel — concurrent guard (already-running → 409)', () => {
  it('status=running → 409 { queued:false, reason:"already-running" }', async () => {
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    await cancelStatus.setStatus('cust-1', { status: 'running', startedAt: new Date() });
    const { app } = await buildApp({ cancelStatus });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ queued: false, reason: 'already-running' });
  });

  it('status=pending → 409 { queued:false, reason:"already-running" }', async () => {
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    await cancelStatus.setStatus('cust-1', { status: 'pending', startedAt: new Date() });
    const { app } = await buildApp({ cancelStatus });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ queued: false, reason: 'already-running' });
  });

  it('status=done → allowed (not 409), re-queues with 202', async () => {
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    const doneResult: CancelTvResult = {
      removed: ['129'], failed: [], unremovable: [], ottDisabled: true,
      local: 'synced', renew: { oldCic: '0000000001', newCic: '0000000002' },
      localCancelled: true, renewAttempted: true, cic: '0000000001',
    };
    await cancelStatus.setStatus('cust-1', { status: 'done', result: doneResult, startedAt: new Date() });
    const { app } = await buildApp({ cancelStatus });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(202);
  });

  it('status=failed → allowed (not 409), re-queues with 202', async () => {
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    await cancelStatus.setStatus('cust-1', { status: 'failed', result: { error: 'upstream timeout' }, startedAt: new Date() });
    const { app } = await buildApp({ cancelStatus });
    const res = await request(app).post('/api/gigared/customers/cust-1/cancel').send({ contractId: 'C1' });
    expect(res.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// GET /customers/:id/cancel/status — read status endpoint
// ---------------------------------------------------------------------------

describe('GET /customers/:id/cancel/status (#10/#11 BE)', () => {
  it('no status yet → 200 { status:"pending" } (null treated as pending)', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/gigared/customers/cust-1/cancel/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.result).toBeUndefined();
    expect(res.body.startedAt).toBeUndefined();
  });

  it('status=running → 200 { status:"running", startedAt: ISO string }', async () => {
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    const startedAt = new Date('2026-07-20T10:00:00.000Z');
    await cancelStatus.setStatus('cust-1', { status: 'running', startedAt });
    const { app } = await buildApp({ cancelStatus });
    const res = await request(app).get('/api/gigared/customers/cust-1/cancel/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
    expect(res.body.startedAt).toBe(startedAt.toISOString());
    expect(res.body.result).toBeUndefined();
  });

  it('status=done → 200 { status:"done", result: CancelTvResult, startedAt }', async () => {
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    const doneResult: CancelTvResult = {
      removed: ['129'], failed: [], unremovable: [], ottDisabled: true,
      local: 'synced', renew: { oldCic: '0000000001', newCic: '0000000002' },
      localCancelled: true, renewAttempted: true, cic: '0000000001',
    };
    const startedAt = new Date('2026-07-20T10:00:00.000Z');
    await cancelStatus.setStatus('cust-1', { status: 'done', result: doneResult, startedAt });
    const { app } = await buildApp({ cancelStatus });
    const res = await request(app).get('/api/gigared/customers/cust-1/cancel/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
    expect(res.body.startedAt).toBe(startedAt.toISOString());
    expect(res.body.result).toMatchObject({ removed: ['129'], failed: [], localCancelled: true });
  });

  it('status=failed → 200 { status:"failed", result: {error}, startedAt }', async () => {
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    const startedAt = new Date('2026-07-20T10:00:00.000Z');
    await cancelStatus.setStatus('cust-1', { status: 'failed', result: { error: 'upstream timeout' }, startedAt });
    const { app } = await buildApp({ cancelStatus });
    const res = await request(app).get('/api/gigared/customers/cust-1/cancel/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.startedAt).toBe(startedAt.toISOString());
    expect(res.body.result).toEqual({ error: 'upstream timeout' });
  });

  it('unknown customer → 404 CLIENT_NOT_FOUND', async () => {
    const { app } = await buildApp({ customerExists: false });
    const res = await request(app).get('/api/gigared/customers/ghost/cancel/status');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CLIENT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// CancelTvJobRunner unit tests (in-memory)
// ---------------------------------------------------------------------------

describe('CancelTvJobRunner — unit (in-memory)', () => {
  function makeCancelTv(result: CancelTvResult): CancelTv {
    const fakeCancelTv = { execute: jest.fn(async () => result) };
    return fakeCancelTv as unknown as CancelTv;
  }

  function makeThrowingCancelTv(msg: string): CancelTv {
    const fakeCancelTv = { execute: jest.fn(async () => { throw new Error(msg); }) };
    return fakeCancelTv as unknown as CancelTv;
  }

  it('run: sets running then done with result on success', async () => {
    const doneResult: CancelTvResult = {
      removed: ['129'], failed: [], unremovable: [], ottDisabled: true,
      local: 'synced', renew: { oldCic: '0000000001', newCic: '0000000002' },
      localCancelled: true, renewAttempted: true, cic: '0000000001',
    };
    const cancelTv = makeCancelTv(doneResult);
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    const runner = new CancelTvJobRunner(cancelTv, cancelStatus);

    await runner.run('cust-1', 'C1');

    const statusRow = await cancelStatus.getStatus('cust-1');
    expect(statusRow?.status).toBe('done');
    expect(statusRow?.result).toMatchObject({ removed: ['129'], localCancelled: true });
  });

  it('run: sets running then failed with {error} on throw', async () => {
    const cancelTv = makeThrowingCancelTv('upstream timeout');
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    const runner = new CancelTvJobRunner(cancelTv, cancelStatus);

    await runner.run('cust-1', 'C1');

    const statusRow = await cancelStatus.getStatus('cust-1');
    expect(statusRow?.status).toBe('failed');
    expect((statusRow?.result as { error: string }).error).toBe('upstream timeout');
  });

  it('run: sets startedAt when transitioning to running', async () => {
    const doneResult: CancelTvResult = {
      removed: [], failed: [], unremovable: [], ottDisabled: true,
      local: 'synced', renew: null, localCancelled: true, renewAttempted: false, cic: '0000000001',
    };
    const cancelTv = makeCancelTv(doneResult);
    const cancelStatus = new InMemoryClientTvCancelStatusRepository();
    const runner = new CancelTvJobRunner(cancelTv, cancelStatus);

    const before = new Date();
    await runner.run('cust-1', 'C1');
    const after = new Date();

    const statusRow = await cancelStatus.getStatus('cust-1');
    expect(statusRow?.startedAt).toBeDefined();
    const startedAt = new Date(statusRow!.startedAt!);
    expect(startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(startedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
