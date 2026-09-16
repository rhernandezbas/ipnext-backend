import request from 'supertest';
import express from 'express';
import { InMemorySchedulingRepository } from '../../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryFeatureFlagRepository } from '../../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryIClassClient } from '../../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassTeamRepository } from '../../../infrastructure/adapters/in-memory/InMemoryIClassTeamRepository';
import { CreateTask } from '../../../application/use-cases/CreateTask';
import { UpdateTask } from '../../../application/use-cases/UpdateTask';
import { SetTaskGeneralStatus } from '../../../application/use-cases/SetTaskGeneralStatus';
import { SendTaskToIClass } from '../../../application/use-cases/SendTaskToIClass';
import { AssignIClassTeam } from '../../../application/use-cases/AssignIClassTeam';
import { createInternalTaskRouter } from '../../../infrastructure/http/routes/internal-tasks.routes';
import { errorHandler } from '../../../infrastructure/http/middleware/errorHandler';
import { EntityLookup } from '../../../domain/ports/EntityLookup';
import { ProjectKindLookup } from '../../../domain/ports/ProjectKindLookup';

// Accepts any non-null ID — FK identity is not under test here, only route wiring.
class AnyLookup implements EntityLookup, ProjectKindLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}
// Rejects everything — used to prove a 404 FK path still routes through this router.
class EmptyLookup implements EntityLookup, ProjectKindLookup {
  async findById(_id: string) { return null; }
}

const anyLookup = new AnyLookup();
const emptyLookup = new EmptyLookup();

function buildApp() {
  const app = express();
  app.use(express.json());

  const stageRepo = new InMemoryStageRepository();
  const repo = new InMemorySchedulingRepository(stageRepo);
  const featureFlags = new InMemoryFeatureFlagRepository();
  const iclassClient = new InMemoryIClassClient();
  const iclassTeamRepo = new InMemoryIClassTeamRepository();

  const createTask = new CreateTask(repo, anyLookup, anyLookup, emptyLookup, anyLookup, emptyLookup);
  const updateTask = new UpdateTask(repo, anyLookup, anyLookup, emptyLookup, anyLookup, emptyLookup);
  const setTaskGeneralStatus = new SetTaskGeneralStatus(repo);
  const sendTaskToIClass = new SendTaskToIClass(repo, featureFlags, iclassClient);
  const assignIClassTeam = new AssignIClassTeam(repo, iclassClient, iclassTeamRepo, featureFlags);

  // No auth middleware whatsoever — internal-only, no cookie/API key required.
  app.use('/api/internal/tasks', createInternalTaskRouter({
    createTask,
    updateTask,
    setTaskGeneralStatus,
    sendTaskToIClass,
    assignIClassTeam,
  }));

  app.use(errorHandler);

  return { app, repo, stageRepo, featureFlags, iclassClient, iclassTeamRepo };
}

const validCreateBody = {
  title: 'Tarea creada por el bot',
  priority: 'normal',
  estimatedHours: 1,
  category: 'other',
  kind: 'customer',
  customerId: 'cust-1',
  contractId: 'contract-1',
};

describe('POST /api/internal/tasks — no auth required', () => {
  it('creates a task without any auth header/cookie and returns 201', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/internal/tasks')
      .send(validCreateBody);

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.title).toBe('Tarea creada por el bot');
    expect(res.body.stageId).toBeTruthy();
  });

  it('missing title → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const { title: _title, ...rest } = validCreateBody;
    const res = await request(app).post('/api/internal/tasks').send(rest);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /api/internal/tasks/:id/status — no auth required', () => {
  it('moves a task to closed and returns 200', async () => {
    const { app } = buildApp();
    const created = await request(app).post('/api/internal/tasks').send(validCreateBody);
    const id = created.body.id as string;

    const res = await request(app)
      .patch(`/api/internal/tasks/${id}/status`)
      .send({ status: 'closed' });

    expect(res.status).toBe(200);
    expect(res.body.generalStatus).toBe('closed');
  });

  it('unknown task id → 404 TASK_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .patch('/api/internal/tasks/nope/status')
      .send({ status: 'closed' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });
});

describe('POST /api/internal/tasks/:id/assign — no auth required', () => {
  it('assigns a technician and returns 200 with assigneeId set', async () => {
    const { app } = buildApp();
    const created = await request(app).post('/api/internal/tasks').send(validCreateBody);
    const id = created.body.id as string;

    const res = await request(app)
      .post(`/api/internal/tasks/${id}/assign`)
      .send({ assigneeId: 'tech-1' });

    expect(res.status).toBe(200);
    expect(res.body.assigneeId).toBe('tech-1');
  });

  it('unknown task id → 404 TASK_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/internal/tasks/nope/assign')
      .send({ assigneeId: 'tech-1' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });
});

describe('POST /api/internal/tasks/:id/send-to-iclass — no auth required', () => {
  const ENVIAR_STAGE_ID = 'stage-enviar-bridge';
  const WORKFLOW_ID = 'wf-bridge-1';
  const REGISTRADO_STAGE_ID = 'stage-registrado-bridge';
  const TEAM_LOGIN = 'equipe-bridge';
  const SCHEDULE_START = '2026-09-20T11:00:00.000Z';
  const SCHEDULE_END = '2026-09-20T15:00:00.000Z';

  const fullBody = {
    targetStageId: ENVIAR_STAGE_ID,
    workflowId: WORKFLOW_ID,
    teamLogin: TEAM_LOGIN,
    scheduleStart: SCHEDULE_START,
    scheduleEnd: SCHEDULE_END,
  };

  /** Seeds a full CUSTOMER task (+ its project mapping) so SendTaskToIClass can create the OS. */
  function seedFullCustomerTask(repo: InMemorySchedulingRepository, id: string) {
    const projectId = `proj-${id}`;
    repo.seedProject({ id: projectId, title: 'Instalaciones FTTH', iclassSoType: { id: 'so-1', code: 'INSTALL', active: true } });
    return repo.seedTask({
      id,
      stageId: ENVIAR_STAGE_ID,
      customerId: 'cust-1',
      customerCode: 'GR-1',
      customerName: 'Juan Perez',
      customerPhone: '341555000',
      customerCity: 'Rosario',
      address: 'Calle Falsa 123',
      description: 'Instalar fibra',
      projectId,
    });
  }

  it('missing teamLogin → 400 VALIDATION_ERROR', async () => {
    const { app, repo } = buildApp();
    seedFullCustomerTask(repo, 't-missing-team');
    const { teamLogin: _teamLogin, ...rest } = fullBody;

    const res = await request(app).post('/api/internal/tasks/t-missing-team/send-to-iclass').send(rest);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('missing scheduleStart → 400 VALIDATION_ERROR', async () => {
    const { app, repo } = buildApp();
    seedFullCustomerTask(repo, 't-missing-start');
    const { scheduleStart: _scheduleStart, ...rest } = fullBody;

    const res = await request(app).post('/api/internal/tasks/t-missing-start/send-to-iclass').send(rest);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('missing scheduleEnd → 400 VALIDATION_ERROR', async () => {
    const { app, repo } = buildApp();
    seedFullCustomerTask(repo, 't-missing-end');
    const { scheduleEnd: _scheduleEnd, ...rest } = fullBody;

    const res = await request(app).post('/api/internal/tasks/t-missing-end/send-to-iclass').send(rest);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('scheduleEnd <= scheduleStart → 400 VALIDATION_ERROR', async () => {
    const { app, repo } = buildApp();
    seedFullCustomerTask(repo, 't-bad-window');

    const res = await request(app)
      .post('/api/internal/tasks/t-bad-window/send-to-iclass')
      .send({ ...fullBody, scheduleStart: SCHEDULE_END, scheduleEnd: SCHEDULE_START });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('unknown task id → 404 TASK_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/internal/tasks/nope/send-to-iclass')
      .send(fullBody);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });

  /** Needed by dispatchToIClass to advance the task once the OS is created. */
  function seedRegistradoStage(stageRepo: InMemoryStageRepository) {
    stageRepo.addDirect({
      id: REGISTRADO_STAGE_ID,
      workflowId: WORKFLOW_ID,
      name: 'Registrado en IClass',
      code: 'registered_in_iclass',
      category: 'enProgreso',
      order: 6,
      color: null,
    });
  }

  it('iclass-assign-action flag OFF (default) → 409 ICLASS_ACTION_DISABLED, schedule already persisted', async () => {
    const { app, repo } = buildApp();
    seedFullCustomerTask(repo, 't-flag-off');

    const res = await request(app).post('/api/internal/tasks/t-flag-off/send-to-iclass').send(fullBody);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ICLASS_ACTION_DISABLED');

    // Step 1 (persist schedule) ran and is NOT rolled back even though step 3 failed —
    // explicit no-compensation design decision.
    const persisted = await repo.getTask('t-flag-off');
    expect(persisted?.startDate).toBe(SCHEDULE_START);
    expect(persisted?.endDate).toBe(SCHEDULE_END);
  });

  it('iclass-integration flag OFF, iclass-assign-action ON → no OS created, assign fails 422 ICLASS_NO_SERVICE_ORDER', async () => {
    const { app, repo, featureFlags } = buildApp();
    featureFlags.seed('iclass-assign-action', true);
    seedFullCustomerTask(repo, 't-no-order');

    const res = await request(app).post('/api/internal/tasks/t-no-order/send-to-iclass').send(fullBody);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ICLASS_NO_SERVICE_ORDER');

    const persisted = await repo.getTask('t-no-order');
    expect(persisted?.startDate).toBe(SCHEDULE_START);
    expect(persisted?.endDate).toBe(SCHEDULE_END);
    expect(persisted?.iclassOrderCode).toBeFalsy();
  });

  it('team not in catalog → 422 ICLASS_TEAM_NOT_ASSIGNABLE', async () => {
    const { app, repo, stageRepo, featureFlags, iclassClient } = buildApp();
    seedRegistradoStage(stageRepo);
    featureFlags.seed('iclass-integration', true);
    featureFlags.seed('iclass-assign-action', true);
    iclassClient.nodes = [{ nodeId: 1, code: 'Rosario', description: 'Rosario' }];
    seedFullCustomerTask(repo, 't-unknown-team');

    const res = await request(app).post('/api/internal/tasks/t-unknown-team/send-to-iclass').send(fullBody);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ICLASS_TEAM_NOT_ASSIGNABLE');
  });

  it('happy path: creates the OS, persists the schedule, and assigns the team', async () => {
    const { app, repo, stageRepo, featureFlags, iclassClient, iclassTeamRepo } = buildApp();

    seedRegistradoStage(stageRepo);
    featureFlags.seed('iclass-integration', true);
    featureFlags.seed('iclass-assign-action', true);
    iclassClient.nodes = [{ nodeId: 1, code: 'Rosario', description: 'Rosario' }];
    iclassClient.nextOrderCode = 'OS-BRIDGE-1';
    iclassClient.setServiceOrderSnapshot('OS-BRIDGE-1', {
      iclassId: 'iclass-bridge-1',
      iclassCodigo: 'OS-BRIDGE-1',
      statusCode: '1',
      statusDescription: 'Aberta',
    });
    await iclassTeamRepo.upsertByLogin({
      login: TEAM_LOGIN,
      name: 'Equipe Bridge',
      thirdPartyCode: null,
      active: true,
      selectable: true,
    });
    seedFullCustomerTask(repo, 't-happy');

    const res = await request(app).post('/api/internal/tasks/t-happy/send-to-iclass').send(fullBody);

    expect(res.status).toBe(200);
    expect(res.body.iclassOrderCode).toBe('OS-BRIDGE-1');

    const persisted = await repo.getTask('t-happy');
    expect(persisted?.startDate).toBe(SCHEDULE_START);
    expect(persisted?.endDate).toBe(SCHEDULE_END);
    expect(persisted?.iclassOrderCode).toBe('OS-BRIDGE-1');

    const calls = iclassClient.getUpdateServiceOrderCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.serviceOrderCode).toBe('OS-BRIDGE-1');
    expect(calls[0]!.requiredTeam).toBe(TEAM_LOGIN);
    expect(calls[0]!.scheduleStart.toISOString()).toBe(SCHEDULE_START);
    expect(calls[0]!.scheduleEnd.toISOString()).toBe(SCHEDULE_END);
  });
});
