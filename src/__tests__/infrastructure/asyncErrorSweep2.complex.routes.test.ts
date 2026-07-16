/**
 * Sweep FASE 2 de handlers async — routers complejos + shape "await FUERA del try".
 *
 * Dos shapes de la misma clase de bug (Express 4, sin express-async-errors):
 *
 *  1. Handler async SIN try/catch (pppoe, radius, iclass-closure, taskAttachments,
 *     taskComments, scheduling GET /:id): el await desnudo rechaza → request COLGADA.
 *  2. Handler CON try/catch pero con un await ANTES del try (scheduling POST / y
 *     tickets POST /:id/tasks: lookup `stageRepo.getDefaultWorkflowStageByLegacyStatus`;
 *     recapture PATCH/POST: `hasAssignPerm`): si ESE await rechaza, el try de más
 *     abajo no lo cubre → request COLGADA igual.
 *
 * "No cuelga": el colaborador inyectado rechaza con un error de infra NO mapeado
 * inline → respuesta INMEDIATA con code INTERNAL_ERROR. En tickets POST /:id/tasks
 * el 500 lo produce su catch inline (wire `error: 'Error interno'`, congelado — ver
 * comentario en la ruta); en el resto lo produce el errorHandler global.
 */
import request from 'supertest';
import express, { RequestHandler, Router } from 'express';
import cookieParser from 'cookie-parser';

import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createPppoeRouter } from '@infrastructure/http/routes/pppoe.routes';
import { createRadiusRouter } from '@infrastructure/http/routes/radius.routes';
import { createIClassClosureRouter } from '@infrastructure/http/routes/iclass-closure.routes';
import { createTaskAttachmentsRouter } from '@infrastructure/http/routes/taskAttachments.routes';
import { createTaskCommentsRouter } from '@infrastructure/http/routes/taskComments.routes';
import { createSchedulingRouter, ChecklistUseCases } from '@infrastructure/http/routes/scheduling.routes';
import { createTicketsRouter } from '@infrastructure/http/routes/tickets.routes';
import { createRecaptureRouter } from '@infrastructure/http/routes/recapture.routes';

import {
  failingUseCase as f,
  fakeAuthProvider,
  passthroughPerm,
  AUTH_COOKIE,
  expectNoHang,
} from '../helpers/noHang';

function appWith(mount: string, router: Router): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(mount, router);
  app.use(errorHandler);
  return app;
}

/** RequestHandler pass-through para guards inyectados como parámetro directo. */
const pt: RequestHandler = (_req, _res, next) => next();

/** StageRepository cuyo lookup de stage default rechaza (infra caída). */
const failingStageRepo = {
  getDefaultWorkflowStageByLegacyStatus: () => Promise.reject(new Error('boom: stage lookup')),
} as unknown as never;

// El errorHandler (y el catch inline de tickets) loguean por diseño — silenciar.
let errSpy: jest.SpyInstance;
beforeAll(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterAll(() => { errSpy.mockRestore(); });

// ── Builders ────────────────────────────────────────────────────────────────

const buildPppoe = (): express.Express =>
  appWith('/api', createPppoeRouter(
    fakeAuthProvider, undefined, passthroughPerm,
    f, f, f, f, f, f, f, f, f, f, f, f, f, f,
  ));

const buildRadius = (): express.Express =>
  appWith('/api/radius', createRadiusRouter(fakeAuthProvider, undefined, passthroughPerm, f, f, f, f, f, f, f));

const buildIClassClosure = (): express.Express =>
  appWith('/api/iclass', createIClassClosureRouter(f, f, f, f, null, null, f, f, f, f, f, f, pt, fakeAuthProvider));

const buildTaskAttachments = (): express.Express =>
  appWith('/api/scheduling', createTaskAttachmentsRouter(
    { attachPhotosToTask: f, listTaskAttachments: f, getTaskAttachmentFile: f, deleteTaskAttachment: f },
    { authProvider: fakeAuthProvider, requireRead: pt, requireWrite: pt },
  ));

const buildTaskComments = (): express.Express =>
  appWith('/api/scheduling', createTaskCommentsRouter(f, f, f, pt, { read: pt, write: pt, delete: pt }));

// scheduling — mismo wiring que el sweep fase 1; stageRepo parametrizable para
// ejercitar el lookup FUERA del try de POST /.
function buildScheduling(stageRepo: never | undefined): express.Express {
  const checklist: ChecklistUseCases = {
    addChecklistItem: f,
    toggleChecklistItem: f,
    updateChecklistItem: f,
    removeChecklistItem: f,
    reorderChecklistItems: f,
    assignTemplateToTask: f,
    clearTaskChecklist: f,
  };
  return appWith('/api/scheduling', createSchedulingRouter(
    f, f, f, f, f, f,
    fakeAuthProvider,
    stageRepo,
    checklist,
    f, undefined, undefined, f, undefined, undefined, f, undefined, f, undefined, undefined,
  ));
}

// Body válido para CreateTaskSchema SIN stageId → fuerza el lookup en stageRepo.
const VALID_CREATE_TASK_BODY = {
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

const buildTickets = (): express.Express =>
  appWith('/api/tickets', createTicketsRouter(
    f, f, f, f, f, f, f,
    f,                        // ticketStatusRepo
    fakeAuthProvider as never, // tipado JwtAuthAdapter concreto; el stub del port alcanza
    undefined,                // rbacUserRepo
    f,                        // createTaskFromTicket
    f,                        // taskRepo
    failingStageRepo,         // stageRepo — el lookup FUERA del try rechaza
  ));

// recapture — hasAssignPerm es el await FUERA de los try de PATCH/POST.
const buildRecapture = (): express.Express =>
  appWith('/api/recapture', createRecaptureRouter(
    f, f, f, f, f, f, f, f,
    () => Promise.reject(new Error('boom: perm lookup')), // hasAssignPerm
    pt,
    { read: pt, manage: pt, assign: pt },
  ));

interface SweepCase {
  name: string;
  method?: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  body?: object;
  build: () => express.Express;
}

const cases: ReadonlyArray<SweepCase> = [
  // ── Shape 1: handler sin try/catch ──
  { name: 'pppoe GET /pppoe/unassigned',                 path: '/api/pppoe/unassigned',      build: buildPppoe },
  { name: 'radius DELETE /sessions/:id',                 method: 'delete', path: '/api/radius/sessions/s1', build: buildRadius },
  { name: 'iclass-closure GET /result-codes',            path: '/api/iclass/result-codes',   build: buildIClassClosure },
  { name: 'taskAttachments GET /:taskId/attachments',    path: '/api/scheduling/t1/attachments', build: buildTaskAttachments },
  { name: 'taskComments GET /:taskId/comments',          path: '/api/scheduling/t1/comments', build: buildTaskComments },
  { name: 'scheduling GET /:id',                         path: '/api/scheduling/t1',         build: () => buildScheduling(undefined) },
  // ── Shape 2: await FUERA del try existente ──
  { name: 'scheduling POST / (stageRepo lookup fuera del try)', method: 'post', path: '/api/scheduling', body: VALID_CREATE_TASK_BODY, build: () => buildScheduling(failingStageRepo) },
  { name: 'tickets POST /:id/tasks (stageRepo lookup fuera del try)', method: 'post', path: '/api/tickets/t1/tasks', body: { contractId: 'c1' }, build: buildTickets },
  { name: 'recapture PATCH /leads/:id (hasAssignPerm fuera del try)', method: 'patch', path: '/api/recapture/leads/l1', body: { status: 'contacted' }, build: buildRecapture },
];

describe('async-error-sweep-2 — complejos y await-fuera-del-try: NO cuelga la request', () => {
  it.each(cases)('$name → respuesta INTERNAL_ERROR inmediata con error de infra no mapeado', async ({ build, method = 'get', path, body }) => {
    const app = build();
    let req = request(app)[method](path).set('Cookie', AUTH_COOKIE);
    if (body !== undefined) req = req.send(body);
    const res = await expectNoHang(req);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  }, 10_000);
});
