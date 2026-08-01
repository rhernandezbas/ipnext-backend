/**
 * TDD — isClosed flag on ScheduledTask
 *
 * Covers:
 * 1. PrismaSchedulingRepository.toTask: maps isClosed from row
 * 2. InMemorySchedulingRepository: updateTask persists isClosed; createTask defaults to false
 * 3. supertest integration: PUT /api/scheduling/:id with { isClosed: true }
 */

import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';

import { toTask } from '../../infrastructure/adapters/prisma/PrismaSchedulingRepository';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { UpdateTask } from '../../application/use-cases/UpdateTask';
import { DeleteTask } from '../../application/use-cases/DeleteTask';
import { MoveTaskToStage } from '../../application/use-cases/MoveTaskToStage';
import { createSchedulingRouter } from '../../infrastructure/http/routes/scheduling.routes';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';
import { Stage } from '../../domain/entities/workflow';
import { EntityLookup } from '../../domain/ports/EntityLookup';

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_STAGE_ID_PENDING = '10000000-0000-4000-a000-000000000001';
const DEFAULT_STAGE_ID_IN_PROGRESS = '10000000-0000-4000-a000-000000000002';
const DEFAULT_STAGE_ID_COMPLETED = '10000000-0000-4000-a000-000000000003';
const DEFAULT_STAGE_ID_CANCELLED = '10000000-0000-4000-a000-000000000004';

class StubLookup implements EntityLookup {
  private ids: Set<string>;
  constructor(...ids: string[]) { this.ids = new Set(ids); }
  async findById(id: string) { return this.ids.has(id) ? { id, isNetworkProject: false } : null; }
}

class FakeAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'admin-1', username: 'testuser', email: 'test@test.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'admin-1', username: 'testuser', email: 'test@test.com', role: 'admin' };
  }
}

function makeDefaultStages(stageRepo: InMemoryStageRepository): void {
  const stages: Stage[] = [
    { id: DEFAULT_STAGE_ID_PENDING,     workflowId: 'wf-default', name: 'Nuevo',            code: 'nuevo',            category: 'nuevo',      order: 0,  color: null },
    { id: DEFAULT_STAGE_ID_IN_PROGRESS, workflowId: 'wf-default', name: 'En progreso',       code: 'en_progreso',      category: 'enProgreso', order: 7,  color: null },
    { id: DEFAULT_STAGE_ID_COMPLETED,   workflowId: 'wf-default', name: 'Hecho',             code: 'hecho',            category: 'hecho',      order: 9,  color: null },
    { id: DEFAULT_STAGE_ID_CANCELLED,   workflowId: 'wf-default', name: 'Anulado-Cancelado', code: 'anulado_cancelado', category: 'hecho',      order: 10, color: null },
  ];
  stages.forEach(s => stageRepo.addDirect(s));
}

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const repo = new InMemorySchedulingRepository();
  const stageRepo = new InMemoryStageRepository();
  makeDefaultStages(stageRepo);

  const authProvider = new FakeAuthProvider();
  const emptyLookup = new StubLookup();

  const router = createSchedulingRouter(
    new ListTasks(repo),
    new GetTask(repo),
    new CreateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup),
    new UpdateTask(repo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup),
    new DeleteTask(repo),
    new MoveTaskToStage(repo, stageRepo),
    authProvider,
    undefined, // sessionRepo
  );
  app.use('/api/scheduling', router);

  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, repo };
}

// ── Minimal Prisma row for toTask tests ──────────────────────────────────────

const BASE_ROW = {
  id: 'test-1',
  sequenceNumber: 1,
  title: 'Test task',
  description: null,
  priority: 'normal',
  estimatedHours: 1,
  address: null,
  lat: null,
  lng: null,
  category: 'other',
  projectId: null,
  project: null,
  completedAt: null,
  notes: null,
  stageId: 'stage-1',
  stage: { id: 'stage-1', name: 'Nuevo', category: 'nuevo' },
  startDate: null,
  endDate: null,
  customerId: null,
  customer: null,
  contractId: null,
  partnerId: null,
  reporterId: null,
  assigneeId: null,
  assignee: null,
  watchers: [],
  checklist: [],
  travelTimeTo: null,
  travelTimeFrom: null,
  isClosed: false,
  createdAt: new Date('2026-05-01T00:00:00Z'),
  updatedAt: new Date('2026-05-01T00:00:00Z'),
};

// ── 1. Prisma mapper ──────────────────────────────────────────────────────────

describe('toTask — isClosed field mapping', () => {
  it('maps isClosed: false from row', () => {
    const task = toTask({ ...BASE_ROW, isClosed: false });
    expect(task.isClosed).toBe(false);
  });

  it('maps isClosed: true from row', () => {
    const task = toTask({ ...BASE_ROW, isClosed: true });
    expect(task.isClosed).toBe(true);
  });

  it('defaults isClosed to false when field is missing (legacy rows)', () => {
    const rowWithoutField = { ...BASE_ROW } as any;
    delete rowWithoutField.isClosed;
    const task = toTask(rowWithoutField);
    expect(task.isClosed).toBe(false);
  });
});

// ── 2. InMemorySchedulingRepository ──────────────────────────────────────────

// Full CreateTaskInput-compatible object (all non-optional non-Omitted fields)
const CREATE_INPUT = {
  title: 'Tarea de prueba',
  description: null,
  stageId: DEFAULT_STAGE_ID_PENDING,
  priority: 'normal',
  estimatedHours: 1,
  address: null,
  coordinates: null,
  category: 'other',
  completedAt: null,
  notes: null,
  startDate: null,
  endDate: null,
  customerId: null,
  contractId: null,
  partnerId: null,
  reporterId: null,
  assigneeId: null,
  travelTimeTo: null,
  travelTimeFrom: null,
};

describe('InMemorySchedulingRepository — isClosed', () => {
  it('createTask defaults isClosed to false', async () => {
    const repo = new InMemorySchedulingRepository();
    const task = await repo.createTask(CREATE_INPUT);
    expect(task.isClosed).toBe(false);
  });

  it('updateTask persists isClosed: true', async () => {
    const repo = new InMemorySchedulingRepository();
    const created = await repo.createTask(CREATE_INPUT);
    const updated = await repo.updateTask(created.id, { isClosed: true });
    expect(updated).not.toBeNull();
    expect(updated!.isClosed).toBe(true);
  });

  it('updateTask persists isClosed: false (reopen)', async () => {
    const repo = new InMemorySchedulingRepository();
    const created = await repo.createTask(CREATE_INPUT);
    await repo.updateTask(created.id, { isClosed: true });
    const reopened = await repo.updateTask(created.id, { isClosed: false });
    expect(reopened!.isClosed).toBe(false);
  });

  it('updateTask without isClosed does not change current isClosed value', async () => {
    const repo = new InMemorySchedulingRepository();
    const created = await repo.createTask(CREATE_INPUT);
    await repo.updateTask(created.id, { isClosed: true });
    const unchanged = await repo.updateTask(created.id, { title: 'Nuevo título' });
    expect(unchanged!.isClosed).toBe(true);
  });

  it('seeded tasks have isClosed: false', async () => {
    const repo = new InMemorySchedulingRepository();
    const tasks = await repo.listTasks();
    tasks.forEach(t => expect(t.isClosed).toBe(false));
  });
});

// ── 3. supertest — PUT /api/scheduling/:id ────────────────────────────────────

describe('PUT /api/scheduling/:id — isClosed flag', () => {
  it('closes a task (isClosed: true) and returns it in the response', async () => {
    const { app, repo } = buildApp();

    const created = await repo.createTask(CREATE_INPUT);

    const res = await request(app)
      .put(`/api/scheduling/${created.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ isClosed: true });

    expect(res.status).toBe(200);
    expect(res.body.isClosed).toBe(true);
  });

  it('reopens a task (isClosed: false)', async () => {
    const { app, repo } = buildApp();

    const created = await repo.createTask(CREATE_INPUT);
    await repo.updateTask(created.id, { isClosed: true });

    const res = await request(app)
      .put(`/api/scheduling/${created.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ isClosed: false });

    expect(res.status).toBe(200);
    expect(res.body.isClosed).toBe(false);
  });

  it('GET /api/scheduling/:id returns isClosed field', async () => {
    const { app, repo } = buildApp();

    const created = await repo.createTask(CREATE_INPUT);

    const res = await request(app)
      .get(`/api/scheduling/${created.id}`)
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('isClosed', false);
  });
});

// ── 4. Filter ?isClosed= in GET /api/scheduling ──────────────────────────────

describe('GET /api/scheduling — ?isClosed filter', () => {
  it('?isClosed=true returns only closed tasks', async () => {
    const { app, repo } = buildApp();

    const open   = await repo.createTask({ ...CREATE_INPUT, title: 'Open task' });
    const closed = await repo.createTask({ ...CREATE_INPUT, title: 'Closed task' });
    await repo.updateTask(closed.id, { isClosed: true });

    const res = await request(app)
      .get('/api/scheduling?isClosed=true')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map(t => t.id);
    expect(ids).toContain(closed.id);
    expect(ids).not.toContain(open.id);
  });

  it('?isClosed=false returns only open tasks', async () => {
    const { app, repo } = buildApp();

    const open   = await repo.createTask({ ...CREATE_INPUT, title: 'Open task' });
    const closed = await repo.createTask({ ...CREATE_INPUT, title: 'Closed task' });
    await repo.updateTask(closed.id, { isClosed: true });

    const res = await request(app)
      .get('/api/scheduling?isClosed=false')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map(t => t.id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(closed.id);
  });
});
