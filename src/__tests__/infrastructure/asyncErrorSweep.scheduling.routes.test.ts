/**
 * Sweep sistémico de handlers async — scheduling router (10 sitios `throw err;`).
 *
 * Checklist (assign-template / order / toggle / update-item), inventory-review,
 * activity, status, archive, POST / y PUT /:id: todos mapean inline sus errores
 * de dominio pero el fallback HOY es `throw err;` — en Express 4 la request
 * queda COLGADA (504 del proxy). El fallback debe ser next(err).
 *
 * Además: CreateTask lanza FibraTaskNoSiteError como defensa en profundidad
 * (el superRefine del DTO cubre el caso normal) y NO está mapeado inline en
 * POST / — su wire contract congelado es 422 FIBRA_TASK_NO_SITE, así que el
 * code tiene que estar en el statusMap del errorHandler global.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createSchedulingRouter, ChecklistUseCases } from '@infrastructure/http/routes/scheduling.routes';
import { FibraTaskNoSiteError } from '@domain/errors/scheduling';

import {
  failingUseCase as f,
  fakeAuthProvider,
  AUTH_COOKIE,
  expectNoHang,
} from '../helpers/noHang';

// Body válido para CreateTaskSchema (clonado del test de rutas de scheduling);
// sin stageRepo inyectado la ruta usa el stageId hardcodeado y llega al use case.
const VALID_CREATE_BODY = {
  title: 'Tarea de test',
  description: 'Descripción test',
  priority: 'normal',
  estimatedHours: 1,
  address: 'Test 123',
  coordinates: null,
  category: 'other',
  completedAt: null,
  notes: '',
  kind: 'customer',
  customerId: 'customer-default-0000-000000000001',
  contractId: 'contract-default-00000-000000000001',
};

function buildApp(createTask: never = f): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const checklist: ChecklistUseCases = {
    addChecklistItem: f,
    toggleChecklistItem: f,
    updateChecklistItem: f,
    removeChecklistItem: f,
    reorderChecklistItems: f,
    assignTemplateToTask: f,
    clearTaskChecklist: f,
  };
  app.use('/api/scheduling', createSchedulingRouter(
    f, f, createTask, f, f, f,   // listTasks, getTask, createTask, updateTask, deleteTask, moveTaskToStage
    fakeAuthProvider,
    undefined,                   // stageRepo — POST / usa el stageId por defecto
    checklist,
    f,                           // setTaskInventoryReview
    undefined,                   // bulkMoveTasksToStage
    undefined,                   // resendDeps
    f,                           // getTaskActivity
    undefined,                   // requireInventoryWrite (pass-through)
    undefined,                   // retireContractEquipment
    f,                           // setTaskGeneralStatus
    undefined,                   // requireSchedulingWrite (pass-through)
    f,                           // archiveTask
    undefined,                   // requireHardDelete (pass-through)
    undefined,                   // iclassActionDeps
  ));
  app.use(errorHandler);
  return app;
}

// El errorHandler loguea [UNHANDLED ERROR] por diseño — silenciarlo acá.
let errSpy: jest.SpyInstance;
beforeAll(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterAll(() => { errSpy.mockRestore(); });

interface SweepCase {
  name: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  body?: object;
}

const cases: ReadonlyArray<SweepCase> = [
  { name: 'POST /:id/checklist/assign-template', method: 'post',  path: '/api/scheduling/t1/checklist/assign-template', body: { templateId: 'tpl' } },
  { name: 'PUT /:id/checklist/order',            method: 'put',   path: '/api/scheduling/t1/checklist/order', body: { orderedIds: [] } },
  { name: 'PATCH /:id/checklist/:itemId/toggle', method: 'patch', path: '/api/scheduling/t1/checklist/i1/toggle' },
  { name: 'PATCH /:id/checklist/:itemId',        method: 'patch', path: '/api/scheduling/t1/checklist/i1', body: { text: 'x' } },
  { name: 'PATCH /:id/inventory-review',         method: 'patch', path: '/api/scheduling/t1/inventory-review', body: { reviewed: true } },
  { name: 'GET /:id/activity',                   method: 'get',   path: '/api/scheduling/t1/activity' },
  { name: 'POST /:id/status',                    method: 'post',  path: '/api/scheduling/t1/status', body: { status: 'open' } },
  { name: 'POST /:id/archive',                   method: 'post',  path: '/api/scheduling/t1/archive' },
  { name: 'POST / (create)',                     method: 'post',  path: '/api/scheduling', body: VALID_CREATE_BODY },
  { name: 'PUT /:id (update)',                   method: 'put',   path: '/api/scheduling/t1', body: { title: 'x' } },
];

describe('async-error-sweep — scheduling: el fallback del catch NO cuelga la request', () => {
  it.each(cases)('$name → 500 INTERNAL_ERROR inmediato con error de infra no mapeado', async ({ method, path, body }) => {
    const app = buildApp();
    let req = request(app)[method](path).set('Cookie', AUTH_COOKIE);
    if (body !== undefined) req = req.send(body);
    const res = await expectNoHang(req);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  }, 10_000);
});

describe('async-error-sweep — scheduling: FIBRA_TASK_NO_SITE via statusMap (defensa en profundidad de CreateTask)', () => {
  it('POST / con CreateTask lanzando FibraTaskNoSiteError → 422 FIBRA_TASK_NO_SITE inmediato (no 400 genérico, no cuelga)', async () => {
    const fibraFailing = {
      execute: () => Promise.reject(new FibraTaskNoSiteError()),
    } as unknown as never;
    const app = buildApp(fibraFailing);
    const res = await expectNoHang(
      request(app).post('/api/scheduling').set('Cookie', AUTH_COOKIE).send(VALID_CREATE_BODY),
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FIBRA_TASK_NO_SITE');
  }, 10_000);
});
