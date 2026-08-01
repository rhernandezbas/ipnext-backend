/**
 * A6.3 [RED] Integration tests: POST /api/scheduling con tareas de RED.
 * Cubre REQ-KIND-1, REQ-KIND-2, REQ-KIND-3, REQ-SHAPE-2, REQ-REF-NETWORK-1.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryNetworkSiteRepository } from '../../infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { UpdateTask } from '../../application/use-cases/UpdateTask';
import { DeleteTask } from '../../application/use-cases/DeleteTask';
import { MoveTaskToStage } from '../../application/use-cases/MoveTaskToStage';
import { createSchedulingRouter } from '../../infrastructure/http/routes/scheduling.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';
import { Stage } from '../../domain/entities/workflow';
import { EntityLookup } from '../../domain/ports/EntityLookup';
import { NetworkSite } from '../../domain/entities/networkSite';

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}

class EmptyLookup implements EntityLookup {
  async findById() { return null; }
}

class FakeAuthProvider implements AuthProvider {
  async login() {
    return { user: { id: 'admin-1', username: 'testuser', email: 'test@test.com', role: 'admin' as const }, cookieValue: 'fake', cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' } };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(): Promise<User> {
    return { id: 'admin-1', username: 'testuser', email: 'test@test.com', role: 'admin' };
  }
}

const DEFAULT_STAGE_ID_PENDING = '10000000-0000-4000-a000-000000000001';

const TEST_SITE: NetworkSite = {
  id: 'site-test-001',
  siteNumber: 1,
  fixedCode: 'NODO 1',
  name: 'Torre Norte Test',
  address: 'Ruta 7 km 5',
  city: 'Mercedes',
  coordinates: null,
  type: 'nodo',
  status: 'active',
  deviceCount: 0,
  clientCount: 0,
  uplink: '1 Gbps',
  parentSiteId: null,
  description: 'Nodo de prueba',
  iclassNodeCode: 'TN-TEST',
  uispSiteId: null,
};

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const repo = new InMemorySchedulingRepository();
  const stageRepo = new InMemoryStageRepository();
  stageRepo.addDirect({
    id: DEFAULT_STAGE_ID_PENDING, workflowId: 'wf-default', name: 'Nuevo',
    code: 'nuevo', category: 'nuevo', order: 0, color: null,
  });

  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  networkSiteRepo.seedSites([TEST_SITE]);

  const anyLookup = new AnyLookup();
  const emptyLookup = new EmptyLookup();
  const sessionAdminLookup = new AnyLookup();

  const createTask = new CreateTask(
    repo, anyLookup, anyLookup, emptyLookup, sessionAdminLookup, emptyLookup,
    undefined, undefined, networkSiteRepo,
  );
  const updateTask = new UpdateTask(repo, anyLookup, anyLookup, emptyLookup, sessionAdminLookup, emptyLookup);
  const deleteTask = new DeleteTask(repo);
  const moveTaskToStage = new MoveTaskToStage(repo, stageRepo);
  const authProvider = new FakeAuthProvider();

  app.use('/api/scheduling', createSchedulingRouter(listTasksUC(repo), getTaskUC(repo), createTask, updateTask, deleteTask, moveTaskToStage, authProvider, undefined));

  // Error handler que mapea errores conocidos
  app.use(errorHandler);

  return app;
}

function listTasksUC(repo: InMemorySchedulingRepository) {
  const { ListTasks } = require('../../application/use-cases/ListTasks');
  return new ListTasks(repo);
}
function getTaskUC(repo: InMemorySchedulingRepository) {
  const { GetTask } = require('../../application/use-cases/GetTask');
  return new GetTask(repo);
}

const BASE_NETWORK_BODY = {
  title: 'Mantenimiento Torre Norte',
  priority: 'normal',
  estimatedHours: 2,
  category: 'maintenance',
  kind: 'network',
  networkSiteId: TEST_SITE.id,
  // #53 — network tasks require a non-blank address.
  address: 'Ruta 7 km 5',
  // #54 — network tasks require a non-blank iclassCityCode (locality).
  iclassCityCode: 'Mercedes',
};

// REQ-KIND-1: Network task created successfully
describe('POST /api/scheduling — network task', () => {
  it('returns 201 with kind=network and networkSiteId (REQ-KIND-1)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send(BASE_NETWORK_BODY);

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('network');
    expect(res.body.networkSiteId).toBe(TEST_SITE.id);
    expect(res.body.customerId).toBeNull();
    expect(res.body.contractId).toBeNull();
  });

  // REQ-KIND-2: Missing networkSiteId → 400
  it('returns 400 when networkSiteId is missing (REQ-KIND-2)', async () => {
    const app = buildApp();
    const { networkSiteId: _, ...noSite } = BASE_NETWORK_BODY;
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send(noSite);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // REQ-KIND-3: Non-existent networkSiteId → 404
  it('returns 404 when networkSiteId does not exist (REQ-KIND-3)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({ ...BASE_NETWORK_BODY, networkSiteId: 'does-not-exist' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NETWORK_SITE_NOT_FOUND');
  });

  // REQ-SHAPE-2: Network task response exposes kind and site fields
  it('response contains kind, networkSiteId, null customerId (REQ-SHAPE-2)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send(BASE_NETWORK_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'network',
      networkSiteId: TEST_SITE.id,
      customerId: null,
      contractId: null,
    });
  });
});

// #66 — Fibra network tasks (networkType='fibra')
const BASE_FIBRA_BODY = {
  title: 'Instalación Fibra Óptica',
  priority: 'normal',
  estimatedHours: 2,
  category: 'installation',
  kind: 'network',
  networkType: 'fibra',
  networkSiteId: null,
  networkSiteName: 'Nodo FO-1',
  address: 'Av. Fibra 100',
  iclassCityCode: 'Mercedes',
};

describe('POST /api/scheduling — fibra network task (#66)', () => {
  it('REQ-FIBRA-ROUTE-1: returns 201 with kind=network, networkType=fibra, networkSiteId=null', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send(BASE_FIBRA_BODY);

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('network');
    expect(res.body.networkType).toBe('fibra');
    expect(res.body.networkSiteId).toBeNull();
    expect(res.body.networkSiteName).toBe('Nodo FO-1');
    expect(res.body.customerId).toBeNull();
  });

  it('REQ-FIBRA-ROUTE-2: fibra + blank networkSiteName → 422 NETWORK_TASK_NODE_NAME_REQUIRED', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({ ...BASE_FIBRA_BODY, networkSiteName: '' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NETWORK_TASK_NODE_NAME_REQUIRED');
  });

  it('REQ-FIBRA-ROUTE-3: fibra + null iclassCityCode → 422 NETWORK_TASK_LOCALITY_REQUIRED', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({ ...BASE_FIBRA_BODY, iclassCityCode: null });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NETWORK_TASK_LOCALITY_REQUIRED');
  });

  it('REQ-FIBRA-ROUTE-4: fibra response has iclassCityCode persisted', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send(BASE_FIBRA_BODY);

    expect(res.status).toBe(201);
    expect(res.body.iclassCityCode).toBe('Mercedes');
  });

  // #66 — Reject the hybrid fibra+site shape end-to-end (REQ-FIBRA-CREATE-1).
  // The DTO superRefine rejects it at the HTTP edge → 422 FIBRA_TASK_NO_SITE
  // (no Prisma 500, no dangling FK winning the JOIN over the free-text name).
  it('REQ-FIBRA-ROUTE-5: fibra + networkSiteId non-null → 422 FIBRA_TASK_NO_SITE', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      // Use an EXISTING site id to prove we reject on SHAPE, not on FK-missing.
      .send({ ...BASE_FIBRA_BODY, networkSiteId: TEST_SITE.id });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FIBRA_TASK_NO_SITE');
  });
});

// #66 — networkType is IMMUTABLE post-create (MEDIUM fix). PUT must reject any
// networkType change with 422 NETWORK_TYPE_IMMUTABLE (identity discriminator, not state).
describe('PUT /api/scheduling/:id — networkType immutable (#66)', () => {
  async function createRedTask(app: ReturnType<typeof buildApp>) {
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send(BASE_NETWORK_BODY);
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function createFibraTask(app: ReturnType<typeof buildApp>) {
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send(BASE_FIBRA_BODY);
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('REQ-IMMUT-ROUTE-1: red→fibra via PUT {networkType:"fibra"} → 422 NETWORK_TYPE_IMMUTABLE', async () => {
    const app = buildApp();
    const id = await createRedTask(app);
    const res = await request(app)
      .put(`/api/scheduling/${id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ networkType: 'fibra' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NETWORK_TYPE_IMMUTABLE');
  });

  it('REQ-IMMUT-ROUTE-2: fibra→red via PUT {networkType:"red"} → 422 NETWORK_TYPE_IMMUTABLE', async () => {
    const app = buildApp();
    const id = await createFibraTask(app);
    const res = await request(app)
      .put(`/api/scheduling/${id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ networkType: 'red' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NETWORK_TYPE_IMMUTABLE');
  });

  it('REQ-IMMUT-ROUTE-3: PUT echoing the SAME networkType is a no-op → 200 (FE resubmits full body)', async () => {
    const app = buildApp();
    const id = await createRedTask(app);
    const res = await request(app)
      .put(`/api/scheduling/${id}`)
      .set('Cookie', 'auth_token=fake')
      // FE edit form resubmits the full body including the unchanged networkType.
      .send({ networkType: 'red', title: 'Renamed red task' });

    expect(res.status).toBe(200);
    expect(res.body.networkType).toBe('red');
    expect(res.body.title).toBe('Renamed red task');
  });
});
