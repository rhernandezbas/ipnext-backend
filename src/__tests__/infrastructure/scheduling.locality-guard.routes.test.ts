/**
 * #54 — Route seam test: locality guard for network tasks.
 *
 * Proves that the global errorHandler wires NetworkTaskLocalityRequiredError → HTTP 422
 * with code NETWORK_TASK_LOCALITY_REQUIRED end-to-end.
 *
 * REQ-LOC-ROUTE-1: POST network task without iclassCityCode → 422, code NETWORK_TASK_LOCALITY_REQUIRED
 * REQ-LOC-ROUTE-2: POST network task with valid iclassCityCode → 201 (regression)
 */
import request from 'supertest';
import express from 'express';
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
import { NetworkSite } from '../../domain/entities/networkSite';
import { EntityLookup } from '../../domain/ports/EntityLookup';

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
  id: 'site-loc-route-001',
  siteNumber: 1,
  fixedCode: 'NODO 1',
  name: 'Torre Test Loc',
  address: 'Ruta 7 km 5',
  city: 'Mercedes',
  coordinates: null,
  type: 'nodo',
  status: 'active',
  deviceCount: 0,
  clientCount: 0,
  uplink: '1 Gbps',
  parentSiteId: null,
  description: 'Nodo de prueba para locality guard',
  iclassNodeCode: 'TN-LOC',
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

  const listTasks = new ListTasks(repo);
  const getTask = new GetTask(repo);

  app.use('/api/scheduling', createSchedulingRouter(listTasks, getTask, createTask, updateTask, deleteTask, moveTaskToStage, authProvider));
  app.use(errorHandler);

  return { app, repo };
}

// BASE body with valid address (#53) but NO iclassCityCode
const BASE_NETWORK_BODY = {
  title: 'Mantenimiento Torre Test Loc',
  priority: 'normal',
  estimatedHours: 2,
  category: 'maintenance',
  kind: 'network',
  networkSiteId: TEST_SITE.id,
  address: 'Ruta 7 km 5',  // #53 address required
};

describe('POST /api/scheduling — network task locality guard (#54)', () => {
  it('POST network task without iclassCityCode → 422 NETWORK_TASK_LOCALITY_REQUIRED (REQ-LOC-ROUTE-1)', async () => {
    const { app } = buildApp();
    // No iclassCityCode field → guard fires
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send(BASE_NETWORK_BODY);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NETWORK_TASK_LOCALITY_REQUIRED');
  });

  it('POST network task with iclassCityCode="" → 422 NETWORK_TASK_LOCALITY_REQUIRED', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({ ...BASE_NETWORK_BODY, iclassCityCode: '' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NETWORK_TASK_LOCALITY_REQUIRED');
  });

  it('POST network task with valid iclassCityCode → 201 (REQ-LOC-ROUTE-2 regression)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/scheduling')
      .set('Cookie', 'auth_token=fake')
      .send({ ...BASE_NETWORK_BODY, iclassCityCode: 'Mercedes' });

    expect(res.status).toBe(201);
    expect(res.body.iclassCityCode).toBe('Mercedes');
  });
});
