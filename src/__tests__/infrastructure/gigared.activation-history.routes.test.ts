/**
 * TDD — TV activation history routes (#5 BE).
 *
 * Wire contract:
 *   GET /api/gigared/customers/activation-history?actorId=&customerId=&from=&to=
 *     → 200 TvActivationEventDto[] (newest first)
 *     → 403 without tv.read permission
 *
 *   GET /api/gigared/customers/:id/activation-history
 *     → 200 TvActivationEventDto[] for that client (newest first)
 *     → 403 without tv.read permission
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
import { CancelTvJobRunner } from '@infrastructure/scheduling/CancelTvJobRunner';
import { ListTvActivationHistory } from '@application/use-cases/gigared/ListTvActivationHistory';

import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';

const FLAG = GIGARED_FLAG;
const pass: RequestHandler = (_req, _res, next) => next();
const deny: RequestHandler = (_req, res) => { res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' }); };

function fakePort(over: Partial<GigaredPort> = {}): GigaredPort {
  const fakeAcc: GigaredAccount = {
    cic: '0000000001', gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '2026-01-19', services: [], internalId: 'cust-1', clientId: 'cust-1', ott: null,
  };
  return {
    getSummary: jest.fn(async () => ({ accounts: { registered: 1, unregistered: 0, total: 1 }, services: [] })),
    listAccounts: jest.fn(async () => [fakeAcc]),
    getAccountByInternalId: jest.fn(async () => fakeAcc),
    getAccountByCic: jest.fn(async () => fakeAcc),
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

interface BuildOpts {
  eventRepo?: InMemoryTvActivationEventRepository;
  requireRead?: RequestHandler;
  flagOn?: boolean;
}

async function buildApp(opts: BuildOpts = {}) {
  const cfg = new InMemoryGigaredConfigRepository();
  await cfg.update({ apiKey: 'secret1234' });
  const flags = new InMemoryFeatureFlagRepository();
  flags.seed(FLAG, opts.flagOn ?? true);

  const port = fakePort();
  const csRepo = new InMemoryContractServiceRepository();
  const catalog = new InMemoryServiceCatalogRepository();
  const cat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (csRepo as any).catalog[cat.id] = { name: cat.name, label: cat.label };

  const customerLookup = { findById: async (id: string) => ({ id, grClienteId: '243200' }) };
  const contractLookup = { findById: async (id: string) => ({ id, clientId: 'cust-1' }) };
  const tvCancellation = new InMemoryClientTvCancellationRepository();
  const cancelStatus = new InMemoryClientTvCancelStatusRepository();
  const eventRepo = opts.eventRepo ?? new InMemoryTvActivationEventRepository();

  const cancelTv = new CancelTv(port, csRepo, catalog, contractLookup, customerLookup, tvCancellation);
  const runner = new CancelTvJobRunner(cancelTv, cancelStatus, eventRepo);

  const listHistory = new ListTvActivationHistory(eventRepo);

  const router = createGigaredRouter({
    getConfig:          new GetGigaredConfig(cfg, flags),
    updateConfig:       new UpdateGigaredConfig(cfg, flags),
    getSummary:         new GetGigaredSummary(port),
    listAccounts:       new ListGigaredAccounts(port),
    getCustomerAccount: new GetGigaredCustomerAccount(port, customerLookup, tvCancellation),
    linkCustomerToCic:  new LinkCustomerToCic(port, customerLookup, contractLookup, csRepo, catalog, tvCancellation),
    registerAccount:    new RegisterGigaredAccount(port, customerLookup, contractLookup, csRepo, catalog, tvCancellation),
    addTvService:       new AddTvService(port, csRepo, catalog, contractLookup, customerLookup),
    removeTvService:    new RemoveTvService(port, csRepo, catalog, contractLookup, customerLookup),
    setOttStatus:       new SetOttStatus(port, customerLookup),
    cancelTv,
    changeTvPassword:   new ChangeTvPassword(port, customerLookup, contractLookup, csRepo, catalog),
    getTvCredentials:   new GetTvCredentials(customerLookup, { getByCustomer: async () => ({ login: 'GIGA100', password: 'ip243200' }) }),
    requireRead:        opts.requireRead ?? pass,
    requireLink:        pass,
    requireRegister:    pass,
    requirePacks:       pass,
    requireOtt:         pass,
    requireCancel:      pass,
    requireManage:      pass,
    gigaredReady:       createGigaredReadyMiddleware(cfg, flags),
    gigaredProbeReady:  createGigaredReadyMiddleware(cfg, flags, { requireFlag: false }),
    cancelTvRunner:     runner,
    cancelStatus,
    customerLookup,
    contractLookup,
    listActivationHistory: listHistory,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/gigared', router);
  app.use(errorHandler);
  return { app, eventRepo };
}

// ─── GET /customers/activation-history — global list ───────────────────────

describe('GET /api/gigared/customers/activation-history — global list (#5 BE)', () => {
  it('returns 200 with empty array when no events', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/gigared/customers/activation-history');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns events newest first', async () => {
    let tick = 0;
    const times = [
      new Date('2026-07-21T09:00:00.000Z'),
      new Date('2026-07-21T10:00:00.000Z'),
    ];
    const eventRepo = new InMemoryTvActivationEventRepository({ now: () => times[tick++]! });
    await eventRepo.record({ clientId: 'c1', actorId: 'a1', actorName: 'Op1', eventType: 'alta' });
    await eventRepo.record({ clientId: 'c2', actorId: 'a2', actorName: 'Op2', eventType: 'baja' });

    const { app } = await buildApp({ eventRepo });
    const res = await request(app).get('/api/gigared/customers/activation-history');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].eventType).toBe('baja');   // newest first
    expect(res.body[1].eventType).toBe('alta');
  });

  it('filters by actorId query param', async () => {
    const eventRepo = new InMemoryTvActivationEventRepository();
    await eventRepo.record({ clientId: 'c1', actorId: 'a1', actorName: 'Op1', eventType: 'alta' });
    await eventRepo.record({ clientId: 'c2', actorId: 'a2', actorName: 'Op2', eventType: 'baja' });

    const { app } = await buildApp({ eventRepo });
    const res = await request(app).get('/api/gigared/customers/activation-history?actorId=a1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].actorId).toBe('a1');
  });

  it('filters by customerId query param', async () => {
    const eventRepo = new InMemoryTvActivationEventRepository();
    await eventRepo.record({ clientId: 'c1', actorId: null, actorName: 'S', eventType: 'alta' });
    await eventRepo.record({ clientId: 'c2', actorId: null, actorName: 'S', eventType: 'alta' });

    const { app } = await buildApp({ eventRepo });
    const res = await request(app).get('/api/gigared/customers/activation-history?customerId=c1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].clientId).toBe('c1');
  });

  it('returns TvActivationEventDto shape', async () => {
    const eventRepo = new InMemoryTvActivationEventRepository();
    await eventRepo.record({
      clientId: 'c1', actorId: 'a1', actorName: 'Operator',
      eventType: 'alta', cic: '0000000001', internalId: 'c1', seq: 0, contractId: 'ct-1',
    });

    const { app } = await buildApp({ eventRepo });
    const res = await request(app).get('/api/gigared/customers/activation-history');
    expect(res.status).toBe(200);
    const dto = res.body[0];
    expect(dto).toMatchObject({
      clientId:  'c1',
      actorId:   'a1',
      actorName: 'Operator',
      eventType: 'alta',
      cic:       '0000000001',
      internalId: 'c1',
      seq:       0,
      contractId: 'ct-1',
    });
    expect(typeof dto.id).toBe('string');
    expect(typeof dto.createdAt).toBe('string');
  });

  it('returns 403 without tv.read permission', async () => {
    const { app } = await buildApp({ requireRead: deny });
    const res = await request(app).get('/api/gigared/customers/activation-history');
    expect(res.status).toBe(403);
  });
});

// ─── GET /customers/:id/activation-history — per-client ─────────────────────

describe('GET /api/gigared/customers/:id/activation-history — per-client (#5 BE)', () => {
  it('returns 200 with empty array for client with no events', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/gigared/customers/cust-1/activation-history');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns only events for the specified client, newest first', async () => {
    let tick = 0;
    const times = [
      new Date('2026-07-21T09:00:00.000Z'),
      new Date('2026-07-21T10:00:00.000Z'),
      new Date('2026-07-21T11:00:00.000Z'),
    ];
    const eventRepo = new InMemoryTvActivationEventRepository({ now: () => times[tick++]! });
    await eventRepo.record({ clientId: 'cust-1', actorId: 'a1', actorName: 'Op', eventType: 'alta' });
    await eventRepo.record({ clientId: 'cust-2', actorId: 'a2', actorName: 'Op', eventType: 'alta' });
    await eventRepo.record({ clientId: 'cust-1', actorId: 'a1', actorName: 'Op', eventType: 'reactivacion' });

    const { app } = await buildApp({ eventRepo });
    const res = await request(app).get('/api/gigared/customers/cust-1/activation-history');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].eventType).toBe('reactivacion'); // newest first
    expect(res.body[1].eventType).toBe('alta');
    expect(res.body.every((e: { clientId: string }) => e.clientId === 'cust-1')).toBe(true);
  });

  it('returns 403 without tv.read permission', async () => {
    const { app } = await buildApp({ requireRead: deny });
    const res = await request(app).get('/api/gigared/customers/cust-1/activation-history');
    expect(res.status).toBe(403);
  });
});
