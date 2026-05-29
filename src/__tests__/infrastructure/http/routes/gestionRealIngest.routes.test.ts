import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { createGestionRealIngestRouter } from '../../../../infrastructure/http/routes/gestionRealIngest.routes';
import { errorHandler } from '../../../../infrastructure/http/middleware/errorHandler';
import { InMemoryGestionRealIngestConfigRepository } from '../../../../infrastructure/adapters/in-memory/InMemoryGestionRealIngestConfigRepository';
import { InMemorySyncStateRepository } from '../../../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemorySchedulingRepository } from '../../../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryProjectRepository } from '../../../../infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { GetIngestConfig } from '../../../../application/use-cases/GetIngestConfig';
import { UpdateIngestConfig } from '../../../../application/use-cases/UpdateIngestConfig';
import { GetIngestStatus } from '../../../../application/use-cases/GetIngestStatus';
import { ListNeedsReviewTasks } from '../../../../application/use-cases/ListNeedsReviewTasks';
import { CreateTaskInput } from '../../../../domain/ports/SchedulingRepository';
import { User } from '../../../../domain/entities/auth';
import { AuthProvider } from '../../../../domain/ports/AuthProvider';
import { AuthenticationError } from '../../../../domain/errors';

const DEFAULT_STAGE_ID = '10000000-0000-4000-a000-000000000001';
const AUTH_COOKIE = 'auth_token=fake';

class FakeAuthProvider implements AuthProvider {
  constructor(private readonly fail: boolean = false) {}
  async login() {
    return {
      user: { id: 'admin-1', username: 'test', email: 'test@test.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    if (this.fail) throw new AuthenticationError('Invalid token');
    return { id: 'admin-1', username: 'test', email: 'test@test.com', role: 'admin' };
  }
}

function taskInput(overrides: Partial<CreateTaskInput>): CreateTaskInput {
  return {
    title: 'Instalación',
    description: null,
    stageId: DEFAULT_STAGE_ID,
    priority: 'normal',
    estimatedHours: 1,
    address: null,
    coordinates: null,
    category: 'installation',
    projectId: null,
    projectName: null,
    completedAt: null,
    notes: null,
    startDate: null,
    endDate: null,
    customerId: null,
    serviceId: null,
    partnerId: null,
    reporterId: null,
    assigneeId: null,
    travelTimeTo: null,
    travelTimeFrom: null,
    grOrdenId: null,
    ...overrides,
  };
}

interface Harness {
  app: express.Express;
  config: InMemoryGestionRealIngestConfigRepository;
  state: InMemorySyncStateRepository;
  scheduling: InMemorySchedulingRepository;
  projects: InMemoryProjectRepository;
}

function buildApp(): Harness {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const config = new InMemoryGestionRealIngestConfigRepository();
  const state = new InMemorySyncStateRepository();
  const scheduling = new InMemorySchedulingRepository();
  const projects = new InMemoryProjectRepository();
  const authProvider = new FakeAuthProvider(false);

  const getIngestConfig = new GetIngestConfig(config);
  const updateIngestConfig = new UpdateIngestConfig(config, projects);
  const getIngestStatus = new GetIngestStatus(state);
  const listNeedsReviewTasks = new ListNeedsReviewTasks(scheduling);

  app.use(
    '/api/gestion-real-ingest',
    createGestionRealIngestRouter(
      authProvider,
      getIngestConfig,
      updateIngestConfig,
      getIngestStatus,
      listNeedsReviewTasks,
    ),
  );
  app.use(errorHandler);

  return { app, config, state, scheduling, projects };
}

describe('gestionRealIngest.routes', () => {
  // ── GET /config ──────────────────────────────────────────────────────────

  it('REQ-GETCFG-1: GET /config returns 200 with the default config DTO before set', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/gestion-real-ingest/config').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false,
      intervalMs: 180000,
      windowMonths: 12,
      fiberProjectId: null,
      wirelessProjectId: null,
    });
  });

  it('GET /config without auth cookie → 401', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/gestion-real-ingest/config');
    expect(res.status).toBe(401);
  });

  // ── PUT /config ──────────────────────────────────────────────────────────

  it('REQ-PUTCFG-1: PUT /config valid body updates and returns 200 with updated DTO', async () => {
    const { app, projects } = buildApp();
    // Seed a real project so the FK passes.
    const fiber = await projects.create({ title: 'Fiber' });
    const res = await request(app)
      .put('/api/gestion-real-ingest/config')
      .set('Cookie', AUTH_COOKIE)
      .send({ enabled: true, intervalMs: 60000, fiberProjectId: fiber.id });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.intervalMs).toBe(60000);
    expect(res.body.fiberProjectId).toBe(fiber.id);
  });

  it('PUT /config with intervalMs:"soon" → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/gestion-real-ingest/config')
      .set('Cookie', AUTH_COOKIE)
      .send({ intervalMs: 'soon' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-PUTCFG-2: PUT /config with non-existent project FK → 404 PROJECT_NOT_FOUND, config unchanged', async () => {
    const { app, config } = buildApp();
    const res = await request(app)
      .put('/api/gestion-real-ingest/config')
      .set('Cookie', AUTH_COOKIE)
      .send({ wirelessProjectId: 'ghost' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROJECT_NOT_FOUND');
    const after = await config.get();
    expect(after.wirelessProjectId).toBeNull();
  });

  it('PUT /config with wirelessProjectId:null clears without a project lookup → 200 null', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/gestion-real-ingest/config')
      .set('Cookie', AUTH_COOKIE)
      .send({ wirelessProjectId: null });
    expect(res.status).toBe(200);
    expect(res.body.wirelessProjectId).toBeNull();
  });

  // ── GET /status ──────────────────────────────────────────────────────────

  it('REQ-STATUS-1: GET /status before any run → 200 with lastRunAt=null and zero counts', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/gestion-real-ingest/status').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      lastRunAt: null,
      created: 0,
      skippedDuplicate: 0,
      skippedUnmirrored: 0,
      unclassified: 0,
    });
  });

  it('REQ-STATUS-1: GET /status after a run → 200 with the run counts', async () => {
    const { app, state } = buildApp();
    const lastRunAt = new Date('2026-05-29T10:00:00.000Z');
    await state.save({
      entity: 'gr-ingest',
      cursor: '29-05-2026',
      lastRunAt,
      lastResult: JSON.stringify({ created: 5, skippedDuplicate: 2, skippedUnmirrored: 1, unclassified: 3 }),
      itemsSynced: 5,
    });
    const res = await request(app).get('/api/gestion-real-ingest/status').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      lastRunAt: lastRunAt.toISOString(),
      created: 5,
      skippedDuplicate: 2,
      skippedUnmirrored: 1,
      unclassified: 3,
    });
  });

  // ── GET /needs-review ──────────────────────────────────────────────────────

  it('REQ-REVIEW-1: GET /needs-review → 200 empty array when nothing needs review', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/gestion-real-ingest/needs-review').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('REQ-REVIEW-1: GET /needs-review → 200 with only the needs-review task', async () => {
    const { app, scheduling } = buildApp();
    await scheduling.createTask(
      taskInput({ title: '[REVISAR - Logística] Instalación Acme', projectId: null, grOrdenId: 'gr-ord-1' }),
    );
    await scheduling.createTask(
      taskInput({ title: 'Instalación Bob', projectId: 'p-fiber', grOrdenId: 'gr-ord-2' }),
    );
    const res = await request(app).get('/api/gestion-real-ingest/needs-review').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].grOrdenId).toBe('gr-ord-1');
    expect(res.body[0].title).toContain('[REVISAR - Logística]');
  });
});
