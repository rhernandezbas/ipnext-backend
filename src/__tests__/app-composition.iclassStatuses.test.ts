/**
 * Composition sanity test for iclass-status-sync.
 * Verifies:
 * 1. /api/admin/iclass/statuses is reachable (GET 200, POST sync 200)
 * 2. IngestClosedServiceOrders receives the statusCatalog when wired
 *
 * Uses in-memory repos + real routers/use-cases (no DB).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createIClassStatusesRouter } from '../infrastructure/http/routes/iclassStatuses.routes';
import { errorHandler } from '../infrastructure/http/middleware/errorHandler';

import { InMemoryIClassStatusCatalogRepository } from '../infrastructure/adapters/in-memory/InMemoryIClassStatusCatalogRepository';
import { InMemoryIClassClient } from '../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemorySchedulingRepository } from '../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryIClassResultCodeRepository } from '../infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemoryClosedServiceOrderRepository } from '../infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';
import { InMemorySyncStateRepository } from '../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryStageRepository } from '../infrastructure/adapters/in-memory/InMemoryStageRepository';

import { SyncIClassStatuses } from '../application/use-cases/SyncIClassStatuses';
import { ListIClassStatusCatalog } from '../application/use-cases/ListIClassStatusCatalog';
import { UpdateIClassStatusCatalog } from '../application/use-cases/UpdateIClassStatusCatalog';
import { IngestClosedServiceOrders } from '../application/use-cases/IngestClosedServiceOrders';

import { User } from '../domain/entities/auth';
import { AuthProvider } from '../domain/ports/AuthProvider';
import { Stage } from '../domain/entities/workflow';

const REGISTRADO: Stage = { id: 'st-reg', workflowId: 'wf', name: 'Registrado', code: 'registered_in_iclass', category: 'nuevo', order: 1, color: null };

class FakeAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'a', username: 'u', email: 'e@e.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_t: string): Promise<User> {
    return { id: 'a', username: 'u', email: 'e@e.com', role: 'admin' };
  }
}

async function buildApp() {
  const catalogRepo = new InMemoryIClassStatusCatalogRepository();
  const iclass = new InMemoryIClassClient();

  const stages = new InMemoryStageRepository();
  stages.addDirect(REGISTRADO);
  const scheduling = new InMemorySchedulingRepository(stages, undefined, catalogRepo);
  const resultCodes = new InMemoryIClassResultCodeRepository();
  const closed = new InMemoryClosedServiceOrderRepository();
  const state = new InMemorySyncStateRepository();

  // IngestClosedServiceOrders receives the statusCatalog (key wiring to verify)
  const ingest = new IngestClosedServiceOrders(
    iclass, closed, resultCodes, scheduling, state,
    { statusCatalog: catalogRepo },
  );

  const syncUC = new SyncIClassStatuses(iclass, catalogRepo);
  const listUC = new ListIClassStatusCatalog(catalogRepo);
  const updateUC = new UpdateIClassStatusCatalog(catalogRepo);

  const ALLOW = (_req: unknown, _res: unknown, next: () => void) => next();

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/admin/iclass',
    createIClassStatusesRouter(
      syncUC,
      listUC,
      updateUC,
      new FakeAuthProvider(),
      undefined,
      ALLOW as never,
      ALLOW as never,
    ),
  );
  app.use(errorHandler);

  return { app, catalogRepo, iclass, scheduling, ingest };
}

describe('app-composition: iclass-status-sync', () => {
  it('GET /api/admin/iclass/statuses → 200 { items }', async () => {
    const { app, catalogRepo } = await buildApp();
    await catalogRepo.upsertByStatusCode({ statusCode: '7', iclassLabel: 'Concluida' });

    const res = await request(app)
      .get('/api/admin/iclass/statuses')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].statusCode).toBe('7');
  });

  it('POST /api/admin/iclass/statuses/sync → 200 with counts (IClass has 0 SOs → synced=0)', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/admin/iclass/statuses/sync')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(typeof res.body.synced).toBe('number');
    expect(typeof res.body.created).toBe('number');
    expect(typeof res.body.updated).toBe('number');
  });

  it('IngestClosedServiceOrders wired with statusCatalog auto-populates catalog', async () => {
    const { catalogRepo, iclass, scheduling, ingest } = await buildApp();
    scheduling.seedTask({ id: 't1', sequenceNumber: 1001, stageId: REGISTRADO.id });
    iclass.serviceOrders = [{
      iclassId: '9001', iclassCodigo: '1001',
      clusterName: 'X', thirdPartyCode: null, nodeCode: null, soTypeId: null, soTypeDescription: null,
      customerCode: 'c', customerName: 'N', addressCode: 'a', addressLine: 'A', addressCity: 'C',
      addressLat: null, addressLng: null, statusCode: '3', statusDescription: 'Agendada',
      requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
      resultCodeName: null, closedByLogin: null, closedByName: null,
      closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: 0,
      technicianNote: null, internalNote: null, commentaryLog: null,
      teamLogin: null, teamTechnicianName: null, teamPhone: null, teamEmail: null,
      iclassCreatedAt: null, iclassUpdatedAt: null, rawDetail: {},
    }];

    await ingest.execute();

    // Catalog auto-populated
    const entry = await catalogRepo.getByStatusCode('3');
    expect(entry).not.toBeNull();
    expect(entry!.iclassLabel).toBe('Agendada');

    // Task got its iclassStatusCode
    const task = await scheduling.getTask('t1');
    expect(task!.iclassStatusCode).toBe('3');
  });
});
