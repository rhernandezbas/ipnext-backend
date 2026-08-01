/**
 * Sweep sistémico de handlers async — workflows router (17 sitios `throw err;`).
 *
 * Workflows + Stages + ProjectCategory + ProjectType: todos los handlers mapean
 * inline sus errores de dominio (instanceof → status) pero el fallback HOY es
 * `throw err;` — en Express 4 la request queda COLGADA (504 del proxy). El
 * fallback debe ser next(err) → errorHandler global.
 *
 * "No cuelga": cada use case rechaza con un error de infra NO mapeado inline →
 * respuesta INMEDIATA 500 INTERNAL_ERROR via el errorHandler global REAL.
 * Se cubren los 17 handlers con fallback, uno por uno.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createWorkflowsRouter } from '@infrastructure/http/routes/workflows.routes';

import {
  failingUseCase as f,
  fakeAuthProvider,
  passthroughPerm,
  AUTH_COOKIE,
  expectNoHang,
} from '../helpers/noHang';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // 20 use cases posicionales — TODOS rechazan con error de infra; cada test
  // golpea una sola ruta, así que cada caso prueba su propio sitio de fallback.
  app.use('/api', createWorkflowsRouter(
    fakeAuthProvider, undefined, passthroughPerm,
    f, f, f, f, f,          // listWorkflows, getWorkflow, create, update, delete
    f, f, f, f, f,          // addStage, removeStage, reorderStages, updateStageColor, updateStage
    f, f, f, f, f,          // list/get/create/update/delete ProjectCategory
    f, f, f, f, f,          // list/get/create/update/delete ProjectType
  ));
  app.use(errorHandler);
  return app;
}

// El errorHandler loguea [UNHANDLED ERROR] por diseño — silenciarlo acá.
let errSpy: jest.SpyInstance;
beforeAll(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterAll(() => { errSpy.mockRestore(); });

const STAGE_UUID = '00000000-0000-4000-a000-000000000001';

interface SweepCase {
  name: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  body?: object;
}

const cases: ReadonlyArray<SweepCase> = [
  // ── Workflows ──
  { name: 'GET /workflows/:id',                method: 'get',    path: '/api/workflows/x' },
  { name: 'POST /workflows',                   method: 'post',   path: '/api/workflows', body: { name: 'wf' } },
  { name: 'PUT /workflows/:id',                method: 'put',    path: '/api/workflows/x', body: { name: 'wf' } },
  { name: 'DELETE /workflows/:id',             method: 'delete', path: '/api/workflows/x' },
  // ── Stages ──
  { name: 'POST /workflows/:id/stages',        method: 'post',   path: '/api/workflows/x/stages', body: { name: 's', category: 'nuevo', order: 0 } },
  { name: 'PUT /workflows/:id/stages/reorder', method: 'put',    path: '/api/workflows/x/stages/reorder', body: { order: [STAGE_UUID] } },
  { name: 'DELETE /workflows/:id/stages/:sid', method: 'delete', path: '/api/workflows/x/stages/y' },
  { name: 'PATCH /workflows/:id/stages/:sid/color', method: 'patch', path: '/api/workflows/x/stages/y/color', body: { color: '#fff' } },
  { name: 'PATCH /workflows/:id/stages/:sid',  method: 'patch',  path: '/api/workflows/x/stages/y', body: { name: 'n' } },
  // ── ProjectCategory ──
  { name: 'GET /project-categories/:id',       method: 'get',    path: '/api/project-categories/x' },
  { name: 'POST /project-categories',          method: 'post',   path: '/api/project-categories', body: { name: 'c' } },
  { name: 'PUT /project-categories/:id',       method: 'put',    path: '/api/project-categories/x', body: { name: 'c' } },
  { name: 'DELETE /project-categories/:id',    method: 'delete', path: '/api/project-categories/x' },
  // ── ProjectType ──
  { name: 'GET /project-types/:id',            method: 'get',    path: '/api/project-types/x' },
  { name: 'POST /project-types',               method: 'post',   path: '/api/project-types', body: { name: 't' } },
  { name: 'PUT /project-types/:id',            method: 'put',    path: '/api/project-types/x', body: { name: 't' } },
  { name: 'DELETE /project-types/:id',         method: 'delete', path: '/api/project-types/x' },
];

describe('async-error-sweep — workflows: el fallback del catch NO cuelga la request', () => {
  it.each(cases)('$name → 500 INTERNAL_ERROR inmediato con error de infra no mapeado', async ({ method, path, body }) => {
    const app = buildApp();
    let req = request(app)[method](path).set('Cookie', AUTH_COOKIE);
    if (body !== undefined) req = req.send(body);
    const res = await expectNoHang(req);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  }, 10_000);
});
