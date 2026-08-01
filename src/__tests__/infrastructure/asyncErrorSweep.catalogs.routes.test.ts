/**
 * Sweep sistémico de handlers async — catálogos CRUD (7 routers, mismo template).
 *
 * Cada router de catálogo (ticketStatuses, ticketAreas, taskPriorities,
 * taskCategories, materialTypeCatalog, deviceTypeCatalog, contractTechnologies)
 * comparte el template GET/:id · POST · PUT · DELETE con mapeos inline
 * (instanceof → status) y un fallback que HOY es `throw err;` — en Express 4
 * eso deja la request COLGADA (504 del proxy). El fallback debe ser next(err).
 *
 * "No cuelga": use case que rechaza con un error de infra NO mapeado inline →
 * respuesta INMEDIATA 500 INTERNAL_ERROR via el errorHandler global REAL.
 * Se prueba GET /:id en los 7 routers (mismo shape) + el template completo
 * (POST/PUT/DELETE) sobre un representante (ticketStatuses).
 */
import request from 'supertest';
import express, { Router } from 'express';
import cookieParser from 'cookie-parser';

import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createTicketStatusesRouter } from '@infrastructure/http/routes/ticketStatuses.routes';
import { createTicketAreasRouter } from '@infrastructure/http/routes/ticketAreas.routes';
import { createTaskPrioritiesRouter } from '@infrastructure/http/routes/taskPriorities.routes';
import { createTaskCategoriesRouter } from '@infrastructure/http/routes/taskCategories.routes';
import { createMaterialTypeCatalogRouter } from '@infrastructure/http/routes/materialTypeCatalog.routes';
import { createDeviceTypeCatalogRouter } from '@infrastructure/http/routes/deviceTypeCatalog.routes';
import { createContractTechnologiesRouter } from '@infrastructure/http/routes/contractTechnologies.routes';

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

// Los catálogos con caché (material/device) reciben un service con invalidate();
// solo se invoca tras un execute() exitoso, que acá nunca ocurre.
const catalogService = { invalidate: (): void => {} } as unknown as never;

// El errorHandler loguea [UNHANDLED ERROR] por diseño — silenciarlo acá.
let errSpy: jest.SpyInstance;
beforeAll(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterAll(() => { errSpy.mockRestore(); });

interface SweepCase {
  name: string;
  method?: 'get' | 'post' | 'put' | 'delete';
  path: string;
  body?: object;
  build: () => express.Express;
}

const buildTicketStatuses = (): express.Express =>
  appWith('/api/ticket-statuses', createTicketStatusesRouter(fakeAuthProvider, undefined, f, f, f, f, f));

const cases: ReadonlyArray<SweepCase> = [
  {
    name: 'ticketStatuses GET /:id',
    path: '/api/ticket-statuses/x',
    build: buildTicketStatuses,
  },
  {
    name: 'ticketAreas GET /:id',
    path: '/api/ticket-areas/x',
    build: () => appWith('/api/ticket-areas', createTicketAreasRouter(fakeAuthProvider, undefined, passthroughPerm, f, f, f, f, f)),
  },
  {
    name: 'taskPriorities GET /task-priorities/:id',
    path: '/api/task-priorities/x',
    build: () => appWith('/api', createTaskPrioritiesRouter(fakeAuthProvider, undefined, f, f, f, f, f)),
  },
  {
    name: 'taskCategories GET /task-categories/:id',
    path: '/api/task-categories/x',
    build: () => appWith('/api', createTaskCategoriesRouter(fakeAuthProvider, undefined, f, f, f, f, f)),
  },
  {
    name: 'materialTypeCatalog GET /material-types/:id',
    path: '/api/material-types/x',
    build: () => appWith('/api', createMaterialTypeCatalogRouter(fakeAuthProvider, undefined, passthroughPerm, f, f, f, f, f, catalogService)),
  },
  {
    name: 'deviceTypeCatalog GET /device-types/:id',
    path: '/api/device-types/x',
    build: () => appWith('/api', createDeviceTypeCatalogRouter(fakeAuthProvider, undefined, passthroughPerm, f, f, f, f, f, catalogService)),
  },
  {
    name: 'contractTechnologies GET /contract-technologies/:id',
    path: '/api/contract-technologies/x',
    build: () => appWith('/api', createContractTechnologiesRouter(fakeAuthProvider, undefined, f, f, f, f, f)),
  },
  // ── Template completo sobre el representante (mismo shape en los 7) ──
  {
    name: 'ticketStatuses POST / (representante del template)',
    method: 'post',
    path: '/api/ticket-statuses',
    body: { name: 'open', color: '#22c55e', weight: 1 },
    build: buildTicketStatuses,
  },
  {
    name: 'ticketStatuses PUT /:id (representante del template)',
    method: 'put',
    path: '/api/ticket-statuses/x',
    body: { color: '#000' },
    build: buildTicketStatuses,
  },
  {
    name: 'ticketStatuses DELETE /:id (representante del template)',
    method: 'delete',
    path: '/api/ticket-statuses/x',
    build: buildTicketStatuses,
  },
];

describe('async-error-sweep — catálogos CRUD: el fallback del catch NO cuelga la request', () => {
  it.each(cases)('$name → 500 INTERNAL_ERROR inmediato con error de infra no mapeado', async ({ build, method = 'get', path, body }) => {
    const app = build();
    let req = request(app)[method](path).set('Cookie', AUTH_COOKIE);
    if (body !== undefined) req = req.send(body);
    const res = await expectNoHang(req);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  }, 10_000);
});
