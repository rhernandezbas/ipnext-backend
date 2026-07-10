/**
 * service-transfer Wave 1 — seam tests de POST /api/gigared/customers/:id/transfer-tv
 * (supertest + router REAL + use case REAL + repos in-memory, lección #28).
 *
 * Wire contract:
 *   200 → alias verificado + severed + slots locales synced
 *   207 → severed=false || localSource='failed' || localTarget='failed' (partner YA transferido)
 *   400 VALIDATION_ERROR · 403 guard deny · 404 TV_NOT_LINKED/CONTRACT_NOT_FOUND ·
 *   409 TV_ALREADY_LINKED · 422 GIGARED_REJECTED · 503 GIGARED_UNAVAILABLE (no cuelga)
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
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryTvActivationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository';
import { CancelTvJobRunner } from '@infrastructure/scheduling/CancelTvJobRunner';

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
import { ListTvActivationHistory } from '@application/use-cases/gigared/ListTvActivationHistory';
import { TransferTvToCustomer } from '@application/use-cases/gigared/TransferTvToCustomer';

import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import { GigaredNotFoundError, GigaredUnavailableError } from '@domain/errors/gigared';

const FLAG = 'gigared-integration';
const CIC = '0000000001';
const pass: RequestHandler = (_req, _res, next) => next();
const deny: RequestHandler = (_req, res) => { res.status(403).json({ error: 'forbidden', code: 'FORBIDDEN' }); };

function fakeAccount(over: Partial<GigaredAccount> = {}): GigaredAccount {
  const base: GigaredAccount = {
    cic: CIC, gigaredId: '100', email: 'e@x.com', firstName: 'N', lastName: 'A',
    registrationDate: '2026-01-19', services: [{ id: '129', name: 'Gigared Play Full' }],
    internalId: 'cust-A', clientId: 'cust-A', ott: null,
  };
  return { ...base, ...over };
}

/** Fake stateful del CUA (mismo seam que el unit test): alias por setInternalId, F0 semantics. */
function transferPort(opts: {
  aliasTakes?: boolean;
  targetPreLinkedCic?: string;
  sourceMissing?: boolean;
  unavailable?: boolean;
} = {}): GigaredPort {
  const account = fakeAccount();
  let aliased = false;
  return {
    getSummary: jest.fn(async () => ({ accounts: { registered: 1, unregistered: 0, total: 1 }, services: [] })),
    listAccounts: jest.fn(async () => [account]),
    getAccountByInternalId: jest.fn(async (id: string) => {
      if (opts.unavailable) throw new GigaredUnavailableError('Gigared API is unavailable', 'CUA timed out');
      if (id === 'cust-A' && !opts.sourceMissing) return account;
      if (id === 'cust-B') {
        if (opts.targetPreLinkedCic) return fakeAccount({ cic: opts.targetPreLinkedCic, internalId: 'cust-B', clientId: 'cust-B' });
        if (aliased && (opts.aliasTakes ?? true)) return account;
      }
      throw new GigaredNotFoundError();
    }),
    getAccountByCic: jest.fn(async () => account),
    register: jest.fn(async () => {}),
    activate: jest.fn(async () => {}),
    setInternalId: jest.fn(async () => { aliased = true; }),
    addService: jest.fn(async () => {}),
    removeService: jest.fn(async () => {}),
    setOtt: jest.fn(async () => {}),
    changePassword: jest.fn(async () => {}),
    renewCic: jest.fn(async () => ({ oldCic: CIC, newCic: '0000000002' })),
  };
}

interface Opts {
  port?: GigaredPort;
  denyTransfer?: boolean;
  tvCancellation?: InMemoryClientTvCancellationRepository;
  breakTargetReconcile?: boolean;
  /** FIX WAVE 2 (FIX-4): rompe SOLO la inactivación del slot origen (patch status:'inactive'). */
  breakSourceInactivation?: boolean;
}

async function buildApp(opts: Opts = {}) {
  const cfg = new InMemoryGigaredConfigRepository();
  await cfg.update({ apiKey: 'secret1234' });
  const flags = new InMemoryFeatureFlagRepository();
  flags.seed(FLAG, true);

  const port = opts.port ?? transferPort();
  const csRepo = new InMemoryContractServiceRepository();
  const catalog = new InMemoryServiceCatalogRepository();
  const cat = await catalog.create({ name: 'TV', label: 'TV', active: true, sortOrder: 0 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (csRepo as any).catalog[cat.id] = { name: cat.name, label: cat.label };
  // Slot TV managed del origen (contrato C-A) con credenciales vivas.
  await csRepo.add({
    contractId: 'C-A', serviceCatalogId: cat.id,
    notes: `CIC ${CIC} · Gigared Play Full`, tvLogin: 'GIGA100', tvPassword: 'ip243200',
  });
  if (opts.breakTargetReconcile) {
    jest.spyOn(csRepo, 'add').mockRejectedValue(new Error('db down'));
  }
  if (opts.breakSourceInactivation) {
    // Solo el wipe del origen falla (único update con status:'inactive' en este flujo); el
    // reconcile del destino (add + carry de credenciales, update sin status) corre normal.
    const realUpdate = csRepo.update.bind(csRepo);
    jest.spyOn(csRepo, 'update').mockImplementation(async (id, data) => {
      if (data.status === 'inactive') throw new Error('db down');
      return realUpdate(id, data);
    });
  }

  // Lookups con OWNERSHIP real: C-A pertenece a cust-A, C-B a cust-B.
  const customerNames: Record<string, string> = { 'cust-A': 'Martino Agustina', 'cust-B': 'Martino Marcelo Julián' };
  const customerLookup = {
    findById: async (id: string) => (id in customerNames ? { id, name: customerNames[id]! } : null),
  };
  const contractOwners: Record<string, string> = { 'C-A': 'cust-A', 'C-B': 'cust-B' };
  const contractLookup = {
    findById: async (id: string) => (id in contractOwners ? { id, clientId: contractOwners[id]!, grContratoId: '243200' } : null),
  };

  const tvCancellation = opts.tvCancellation ?? new InMemoryClientTvCancellationRepository();
  const cancelStatus = new InMemoryClientTvCancelStatusRepository();
  const eventRepo = new InMemoryContractServiceEventRepository();

  const cancelTv = new CancelTv(port, csRepo, catalog, contractLookup, customerLookup, tvCancellation);
  const cancelTvRunner = new CancelTvJobRunner(cancelTv, cancelStatus);
  const transferTv = new TransferTvToCustomer(port, customerLookup, contractLookup, csRepo, catalog, tvCancellation, eventRepo);

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
    getTvCredentials: new GetTvCredentials(customerLookup, { getByCustomer: async () => null }),
    transferTv,
    requireRead: pass,
    requireLink: pass,
    requireRegister: pass,
    requirePacks: pass,
    requireOtt: pass,
    requireCancel: pass,
    requireTransfer: opts.denyTransfer ? deny : pass,
    requireManage: pass,
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
  // Actor autenticado — el evento debe llevar actorId/actorName.
  app.use((req, _res, next) => { req.user = { id: 'op-1', username: 'caro', email: 'caro@test.local' }; next(); });
  app.use('/api/gigared', router);
  app.use(errorHandler);
  return { app, port, csRepo, catalog, tvCatalogId: cat.id, tvCancellation, eventRepo };
}

let warnSpy: jest.SpyInstance;
beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warnSpy.mockRestore(); });

describe('POST /api/gigared/customers/:id/transfer-tv (service-transfer Wave 1)', () => {
  it('200 happy: alias verificado + severed + slots synced + eventos en ambos historiales', async () => {
    const { app, csRepo, tvCatalogId, tvCancellation, eventRepo } = await buildApp();
    const res = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetCustomerId: 'cust-B', targetContractId: 'C-B' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cic: CIC, severed: true, targetCleared: true, localSource: 'synced', localTarget: 'synced' });

    // Seam completo: estado local consistente detrás de la ruta.
    expect(await tvCancellation.isCancelled('cust-A')).toBe(true);
    expect((await csRepo.getByPair('C-A', tvCatalogId))!.status).toBe('inactive');
    expect((await csRepo.getByPair('C-B', tvCatalogId))!.status).toBe('active');
    const kinds = eventRepo.all().map((e) => e.changeKind).sort();
    expect(kinds).toEqual(['transfer-in', 'transfer-out']);
    expect(eventRepo.all().every((e) => e.actorId === 'op-1' && e.actorName === 'caro')).toBe(true);
  });

  it('207 parcial: markCancelled falla → severed:false con el detalle en el body', async () => {
    class FailingMark extends InMemoryClientTvCancellationRepository {
      override async markCancelled(): Promise<void> { throw new Error('db down'); }
    }
    const { app } = await buildApp({ tvCancellation: new FailingMark() });
    const res = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(res.status).toBe(207);
    expect(res.body.severed).toBe(false);
    expect(res.body.cic).toBe(CIC);
  });

  it('FIX-4 — 207 parcial: la inactivación del slot ORIGEN falla → localSource:"failed" (antes solo cubierto en unit)', async () => {
    const { app, csRepo, tvCatalogId } = await buildApp({ breakSourceInactivation: true });
    const res = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(res.status).toBe(207);
    expect(res.body.localSource).toBe('failed');
    expect(res.body.localTarget).toBe('synced');
    expect(res.body.severed).toBe(true);
    // Orden FIX-3 detrás de la ruta: el destino YA quedó escrito con las credenciales; el
    // origen sigue activo con las suyas (copia, no pérdida — el retry resume lo inactiva).
    const target = await csRepo.getByPair('C-B', tvCatalogId);
    expect(target!.status).toBe('active');
    expect(target!.tvLogin).toBe('GIGA100');
    const source = await csRepo.getByPair('C-A', tvCatalogId);
    expect(source!.status).toBe('active');
  });

  it('207 parcial: reconcile del destino falla → localTarget:"failed"', async () => {
    const { app } = await buildApp({ breakTargetReconcile: true });
    const res = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(res.status).toBe(207);
    expect(res.body.localTarget).toBe('failed');
    expect(res.body.severed).toBe(true);
  });

  it('MEDIUM-2 — 207 parcial: clearCancelled(destino) falla → targetCleared:false visible en el body', async () => {
    class FailingClear extends InMemoryClientTvCancellationRepository {
      override async clearCancelled(): Promise<void> { throw new Error('db down'); }
    }
    const { app } = await buildApp({ tvCancellation: new FailingClear() });
    const res = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(res.status).toBe(207);
    expect(res.body.targetCleared).toBe(false);
    expect(res.body.severed).toBe(true);
  });

  it('HIGH-1 resume: tras un 207 (severed:false) el retry del MISMO request devuelve 200 con severed:true', async () => {
    class FailOnceMark extends InMemoryClientTvCancellationRepository {
      private failNext = true;
      override async markCancelled(clientId: string): Promise<void> {
        if (this.failNext) { this.failNext = false; throw new Error('db down'); }
        return super.markCancelled(clientId);
      }
    }
    const { app, tvCancellation } = await buildApp({ tvCancellation: new FailOnceMark() });

    const first = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(first.status).toBe(207);
    expect(first.body.severed).toBe(false);

    // El 207 promete retry direccionado: el MISMO POST debe completar (modo resume), no chocar 409/404.
    const second = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(second.status).toBe(200);
    expect(second.body.severed).toBe(true);
    expect(await tvCancellation.isCancelled('cust-A')).toBe(true);
  });

  it('404 TV_NOT_LINKED: el origen no resuelve upstream', async () => {
    const { app } = await buildApp({ port: transferPort({ sourceMissing: true }) });
    const res = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TV_NOT_LINKED');
  });

  it('404 CONTRACT_NOT_FOUND: contrato destino ajeno (sin leak) y Gigared NUNCA llamado', async () => {
    const { app, port } = await buildApp();
    const res = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetCustomerId: 'cust-B', targetContractId: 'C-A' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
    expect(port.setInternalId).not.toHaveBeenCalled();
  });

  it('409 TV_ALREADY_LINKED: el destino ya tiene TV vigente, sin setInternalId', async () => {
    const { app, port } = await buildApp({ port: transferPort({ targetPreLinkedCic: '0000009999' }) });
    const res = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TV_ALREADY_LINKED');
    expect(port.setInternalId).not.toHaveBeenCalled();
  });

  it('422 GIGARED_REJECTED: el CUA respondió 200 pero el alias no tomó (F0)', async () => {
    const { app, tvCancellation, eventRepo } = await buildApp({ port: transferPort({ aliasTakes: false }) });
    const res = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GIGARED_REJECTED');
    // Cero efectos locales detrás de la ruta.
    expect(await tvCancellation.isCancelled('cust-A')).toBe(false);
    expect(eventRepo.all()).toHaveLength(0);
  });

  it('403 guard deny: sin tv.transfer no hay efectos (use case nunca corre)', async () => {
    const { app, port } = await buildApp({ denyTransfer: true });
    const res = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(res.status).toBe(403);
    expect(port.getAccountByInternalId).not.toHaveBeenCalled();
    expect(port.setInternalId).not.toHaveBeenCalled();
  });

  it('400 VALIDATION_ERROR: body sin targetContractId', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetCustomerId: 'cust-B' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR: body sin targetCustomerId', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetContractId: 'C-B' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('MEDIUM-B2 — 400 VALIDATION_ERROR: request SIN body (req.body undefined), no un 500', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/gigared/customers/cust-A/transfer-tv');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('MEDIUM-3c — 400 VALIDATION_ERROR: sourceContractId presente pero NO string (antes se descartaba en silencio)', async () => {
    const { app, port } = await buildApp();
    const res = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetCustomerId: 'cust-B', targetContractId: 'C-B', sourceContractId: 123 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    // Cero efectos: el use case nunca corrió.
    expect(port.setInternalId).not.toHaveBeenCalled();
  });

  it('no cuelga: GigaredUnavailableError → 503 GIGARED_UNAVAILABLE inmediato', async () => {
    const { app } = await buildApp({ port: transferPort({ unavailable: true }) });
    const res = await request(app)
      .post('/api/gigared/customers/cust-A/transfer-tv')
      .send({ targetCustomerId: 'cust-B', targetContractId: 'C-B' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('GIGARED_UNAVAILABLE');
    expect(res.body.detail).toBe('CUA timed out');
  });
});
