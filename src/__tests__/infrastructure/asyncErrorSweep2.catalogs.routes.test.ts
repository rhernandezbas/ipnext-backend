/**
 * Sweep FASE 2 de handlers async — routers CON auth/perm en la factory (19 routers).
 *
 * Mismo bug que asyncErrorSweep2.crud: handlers `async` cuyo `await` corre SIN
 * try/catch — el rechazo no llega al errorHandler en Express 4 y la request
 * queda COLGADA (504 del proxy). Acá caen los GETs de listado que la fase 1
 * NO tocó (esa ola solo barrió catches con `throw err;` — estos handlers no
 * tenían catch en absoluto).
 *
 * "No cuelga": use case que rechaza con un error de infra NO mapeado inline →
 * respuesta INMEDIATA 500 INTERNAL_ERROR via el errorHandler global REAL.
 */
import request from 'supertest';
import express, { Router, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';

import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createBillingRouter } from '@infrastructure/http/routes/billing.routes';
import { createClientsRouter } from '@infrastructure/http/routes/clients.routes';
import { createContractsRouter } from '@infrastructure/http/routes/contracts.routes';
import { createContractServicesRouter } from '@infrastructure/http/routes/contractServices.routes';
import { createContractTechnologiesRouter } from '@infrastructure/http/routes/contractTechnologies.routes';
import { createDeviceTypeCatalogRouter } from '@infrastructure/http/routes/deviceTypeCatalog.routes';
import { createFeatureFlagsRouter } from '@infrastructure/http/routes/featureFlags.routes';
import { createGestionRealRouter } from '@infrastructure/http/routes/gestionReal.routes';
import { createIpNetworkRouter } from '@infrastructure/http/routes/ipNetwork.routes';
import { createMaterialTypeCatalogRouter } from '@infrastructure/http/routes/materialTypeCatalog.routes';
import { createNasRouter } from '@infrastructure/http/routes/nas.routes';
import { createProjectsRouter } from '@infrastructure/http/routes/projects.routes';
import { createServiceCatalogRouter } from '@infrastructure/http/routes/serviceCatalog.routes';
import { createTaskCategoriesRouter } from '@infrastructure/http/routes/taskCategories.routes';
import { createTaskPrioritiesRouter } from '@infrastructure/http/routes/taskPriorities.routes';
import { createTaskTemplateRouter } from '@infrastructure/http/routes/taskTemplate.routes';
import { createTicketAreasRouter } from '@infrastructure/http/routes/ticketAreas.routes';
import { createTicketStatusesRouter } from '@infrastructure/http/routes/ticketStatuses.routes';
import { createWorkflowsRouter } from '@infrastructure/http/routes/workflows.routes';

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

// Los catálogos con caché (material/device) reciben un service con invalidate();
// solo se invoca tras un execute() exitoso, que acá nunca ocurre.
const catalogService = { invalidate: (): void => {} } as unknown as never;

// El errorHandler loguea [UNHANDLED ERROR] por diseño — silenciarlo acá.
let errSpy: jest.SpyInstance;
beforeAll(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterAll(() => { errSpy.mockRestore(); });

interface SweepCase {
  name: string;
  method?: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  body?: object;
  build: () => express.Express;
}

const cases: ReadonlyArray<SweepCase> = [
  // El router tipa authProvider como JwtAuthAdapter concreto; el stub del port alcanza.
  { name: 'billing GET /summary',                       path: '/api/billing/summary',        build: () => appWith('/api/billing', createBillingRouter(f, f, f, f, fakeAuthProvider as never, undefined)) },
  { name: 'clients GET /:id/contracts',                 path: '/api/clients/99/contracts',   build: () => appWith('/api/clients', createClientsRouter(f, f, f, f, f, fakeAuthProvider as never, undefined, f, f, f, f, passthroughPerm)) },
  { name: 'contracts GET /contracts',                   path: '/api/contracts',              build: () => appWith('/api', createContractsRouter(fakeAuthProvider, undefined, f, f, f, passthroughPerm)) },
  { name: 'contractServices GET /contracts/:cid/service-history', path: '/api/contracts/c1/service-history', build: () => appWith('/api', createContractServicesRouter(fakeAuthProvider, undefined, passthroughPerm, f, f, f, f, f)) },
  { name: 'contractTechnologies GET /contract-technologies', path: '/api/contract-technologies', build: () => appWith('/api', createContractTechnologiesRouter(fakeAuthProvider, undefined, f, f, f, f, f)) },
  { name: 'deviceTypeCatalog GET /device-types',        path: '/api/device-types',           build: () => appWith('/api', createDeviceTypeCatalogRouter(fakeAuthProvider, undefined, passthroughPerm, f, f, f, f, f, catalogService)) },
  { name: 'featureFlags GET /',                         path: '/api/feature-flags',          build: () => appWith('/api/feature-flags', createFeatureFlagsRouter(fakeAuthProvider, undefined, f, f, f, pt)) },
  { name: 'gestionReal GET /sync/status',               path: '/api/gestion-real/sync/status', build: () => appWith('/api/gestion-real', createGestionRealRouter(fakeAuthProvider, undefined, f)) },
  { name: 'ipNetwork GET /ip-networks',                 path: '/api/ip-networks',            build: () => appWith('/api', createIpNetworkRouter(fakeAuthProvider, undefined, passthroughPerm, f, f, f, f, f, f)) },
  { name: 'materialTypeCatalog GET /material-types',    path: '/api/material-types',         build: () => appWith('/api', createMaterialTypeCatalogRouter(fakeAuthProvider, undefined, passthroughPerm, f, f, f, f, f, catalogService)) },
  { name: 'nas GET /nas-servers',                       path: '/api/nas-servers',            build: () => appWith('/api', createNasRouter(fakeAuthProvider, undefined, passthroughPerm, f, f, f, f, f, f, f)) },
  { name: 'projects GET /',                             path: '/api/projects',               build: () => appWith('/api/projects', createProjectsRouter(f, f, f, f, f, fakeAuthProvider, undefined)) },
  { name: 'serviceCatalog GET /service-catalog',        path: '/api/service-catalog',        build: () => appWith('/api', createServiceCatalogRouter(fakeAuthProvider, undefined, passthroughPerm, f, f, f, f)) },
  { name: 'taskCategories GET /task-categories',        path: '/api/task-categories',        build: () => appWith('/api', createTaskCategoriesRouter(fakeAuthProvider, undefined, f, f, f, f, f)) },
  { name: 'taskPriorities GET /task-priorities',        path: '/api/task-priorities',        build: () => appWith('/api', createTaskPrioritiesRouter(fakeAuthProvider, undefined, f, f, f, f, f)) },
  { name: 'taskTemplate GET /',                         path: '/api/task-templates',         build: () => appWith('/api/task-templates', createTaskTemplateRouter(f, f, f, f, f, fakeAuthProvider, undefined, f)) },
  { name: 'ticketAreas GET /',                          path: '/api/ticket-areas',           build: () => appWith('/api/ticket-areas', createTicketAreasRouter(fakeAuthProvider, undefined, passthroughPerm, f, f, f, f, f)) },
  { name: 'ticketStatuses GET /',                       path: '/api/ticket-statuses',        build: () => appWith('/api/ticket-statuses', createTicketStatusesRouter(fakeAuthProvider, undefined, f, f, f, f, f)) },
  { name: 'workflows GET /workflows',                   path: '/api/workflows',              build: () => appWith('/api', createWorkflowsRouter(fakeAuthProvider, undefined, passthroughPerm, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f, f)) },
];

describe('async-error-sweep-2 — routers con auth: un await desnudo que rechaza NO cuelga la request', () => {
  it.each(cases)('$name → 500 INTERNAL_ERROR inmediato con error de infra no mapeado', async ({ build, method = 'get', path, body }) => {
    const app = build();
    let req = request(app)[method](path).set('Cookie', AUTH_COOKIE);
    if (body !== undefined) req = req.send(body);
    const res = await expectNoHang(req);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  }, 10_000);
});
