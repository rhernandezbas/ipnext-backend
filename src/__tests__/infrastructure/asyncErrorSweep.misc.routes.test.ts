/**
 * Sweep sistémico de handlers async — routers restantes (12 sitios `throw err;`):
 * serviceCatalog (3) · contractServices (3) · projects (2) · clients (2) ·
 * taskTemplate (1) · contracts (1).
 *
 * Mismo bug del template CRUD: mapeos inline correctos pero fallback
 * `throw err;` — en Express 4 la request queda COLGADA (504 del proxy).
 * El fallback debe ser next(err) → errorHandler global.
 *
 * "No cuelga": use case que rechaza con un error de infra NO mapeado inline →
 * respuesta INMEDIATA 500 INTERNAL_ERROR via el errorHandler global REAL.
 */
import request from 'supertest';
import express, { Router } from 'express';
import cookieParser from 'cookie-parser';

import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createServiceCatalogRouter } from '@infrastructure/http/routes/serviceCatalog.routes';
import { createContractServicesRouter } from '@infrastructure/http/routes/contractServices.routes';
import { createProjectsRouter } from '@infrastructure/http/routes/projects.routes';
import { createClientsRouter } from '@infrastructure/http/routes/clients.routes';
import { createTaskTemplateRouter } from '@infrastructure/http/routes/taskTemplate.routes';
import { createContractsRouter } from '@infrastructure/http/routes/contracts.routes';

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

// El errorHandler loguea [UNHANDLED ERROR] por diseño — silenciarlo acá.
let errSpy: jest.SpyInstance;
beforeAll(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterAll(() => { errSpy.mockRestore(); });

const buildServiceCatalog = (): express.Express =>
  appWith('/api', createServiceCatalogRouter(fakeAuthProvider, passthroughPerm, f, f, f, f));

const buildContractServices = (): express.Express =>
  appWith('/api', createContractServicesRouter(fakeAuthProvider, passthroughPerm, f, f, f, f, f));

const buildProjects = (): express.Express =>
  appWith('/api/projects', createProjectsRouter(f, f, f, f, f, fakeAuthProvider));

const buildClients = (): express.Express =>
  // El router tipa authProvider como JwtAuthAdapter concreto; el stub del port alcanza.
  appWith('/api/clients', createClientsRouter(f, f, f, f, f, fakeAuthProvider as never, f, f, f, f, passthroughPerm));

const buildTaskTemplates = (): express.Express =>
  appWith('/api/task-templates', createTaskTemplateRouter(f, f, f, f, f, fakeAuthProvider, f));

const buildContracts = (): express.Express =>
  appWith('/api', createContractsRouter(fakeAuthProvider, f, f, f, passthroughPerm));

interface SweepCase {
  name: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  body?: object;
  build: () => express.Express;
}

const cases: ReadonlyArray<SweepCase> = [
  // ── serviceCatalog (3) ──
  { name: 'serviceCatalog POST /service-catalog',        method: 'post',   path: '/api/service-catalog', body: { name: 'x' }, build: buildServiceCatalog },
  { name: 'serviceCatalog PATCH /service-catalog/:id',   method: 'patch',  path: '/api/service-catalog/x', body: { name: 'y' }, build: buildServiceCatalog },
  { name: 'serviceCatalog DELETE /service-catalog/:id',  method: 'delete', path: '/api/service-catalog/x', build: buildServiceCatalog },
  // ── contractServices (3) ──
  { name: 'contractServices PATCH /contracts/:id',       method: 'patch',  path: '/api/contracts/c1', body: { name: 'x' }, build: buildContractServices },
  { name: 'contractServices POST /contracts/:cid/services', method: 'post', path: '/api/contracts/c1/services', body: { serviceCatalogId: 'sc' }, build: buildContractServices },
  { name: 'contractServices PATCH /contracts/:cid/services/:id', method: 'patch', path: '/api/contracts/c1/services/s1', body: { status: 'active' }, build: buildContractServices },
  // ── projects (2) ──
  { name: 'projects POST /',                             method: 'post',   path: '/api/projects', body: { title: 'X' }, build: buildProjects },
  { name: 'projects DELETE /:id',                        method: 'delete', path: '/api/projects/p1', build: buildProjects },
  // ── clients (2) ──
  { name: 'clients GET /:id',                            method: 'get',    path: '/api/clients/99999', build: buildClients },
  { name: 'clients PATCH /:id (location)',               method: 'patch',  path: '/api/clients/99999', body: { lat: 1 }, build: buildClients },
  // ── taskTemplate (1) ──
  { name: 'taskTemplate PUT /:id/items',                 method: 'put',    path: '/api/task-templates/t1/items', body: { items: [{ text: 'a' }] }, build: buildTaskTemplates },
  // ── contracts (1) ──
  { name: 'contracts PATCH /contracts/:id/location',     method: 'patch',  path: '/api/contracts/c1/location', body: { gpsLat: 1 }, build: buildContracts },
];

describe('async-error-sweep — routers restantes: el fallback del catch NO cuelga la request', () => {
  it.each(cases)('$name → 500 INTERNAL_ERROR inmediato con error de infra no mapeado', async ({ build, method, path, body }) => {
    const app = build();
    let req = request(app)[method](path).set('Cookie', AUTH_COOKIE);
    if (body !== undefined) req = req.send(body);
    const res = await expectNoHang(req);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  }, 10_000);
});
