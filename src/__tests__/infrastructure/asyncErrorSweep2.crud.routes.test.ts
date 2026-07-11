/**
 * Sweep FASE 2 de handlers async — routers CRUD SIN auth en la factory (22 routers).
 *
 * Fase 1 barrió los `throw err;` dentro de catches. Esta ola barre el otro shape:
 * handlers `async` cuyo `await` corre SIN try/catch. Si ese await rechaza
 * (p. ej. Prisma caído), en Express 4 el rechazo NO llega al errorHandler →
 * la request queda COLGADA y el proxy la corta a ~60s (504).
 *
 * "No cuelga": use case que rechaza con un error de infra NO mapeado inline →
 * respuesta INMEDIATA 500 INTERNAL_ERROR via el errorHandler global REAL.
 * Un caso por router: el sitio más representativo (GET de listado, sin
 * validación previa — el await desnudo es la primera línea ejecutable).
 */
import request from 'supertest';
import express, { Router } from 'express';
import cookieParser from 'cookie-parser';

import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createAdminRouter } from '@infrastructure/http/routes/admin.routes';
import { createBillingMonthlyRouter } from '@infrastructure/http/routes/billingMonthly.routes';
import { createClientCommentsRouter } from '@infrastructure/http/routes/clientComments.routes';
import { createCpeRouter } from '@infrastructure/http/routes/cpe.routes';
import { createCreditNotesRouter } from '@infrastructure/http/routes/creditNotes.routes';
import { createDashboardRouter } from '@infrastructure/http/routes/dashboard.routes';
import { createEmpresaRouter } from '@infrastructure/http/routes/empresa.routes';
import { createFinanceHistoryRouter } from '@infrastructure/http/routes/financeHistory.routes';
import { createGponRouter } from '@infrastructure/http/routes/gpon.routes';
import { createHardwareRouter } from '@infrastructure/http/routes/hardware.routes';
import { createLeadsRouter } from '@infrastructure/http/routes/leads.routes';
import { createMessagesRouter } from '@infrastructure/http/routes/messages.routes';
import { createMonitoringRouter } from '@infrastructure/http/routes/monitoring.routes';
import { createNetworkSiteRouter } from '@infrastructure/http/routes/networkSite.routes';
import { createNotificationsRouter } from '@infrastructure/http/routes/notifications.routes';
import { createPartnerRouter } from '@infrastructure/http/routes/partner.routes';
import { createProformasRouter } from '@infrastructure/http/routes/proformas.routes';
import { createRoleRouter } from '@infrastructure/http/routes/role.routes';
import { createSettingsRouter } from '@infrastructure/http/routes/settings.routes';
import { createTr069Router } from '@infrastructure/http/routes/tr069.routes';
import { createUbicacionesRouter } from '@infrastructure/http/routes/ubicaciones.routes';
import { createVozRouter } from '@infrastructure/http/routes/voz.routes';

import { failingUseCase as f, AUTH_COOKIE, expectNoHang } from '../helpers/noHang';

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

interface SweepCase {
  name: string;
  method?: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  body?: object;
  build: () => express.Express;
}

const cases: ReadonlyArray<SweepCase> = [
  { name: 'admin GET /',                    path: '/api/admins',                build: () => appWith('/api/admins', createAdminRouter(f, f, f, f, f, f, f, f)) },
  { name: 'billingMonthly GET /monthly',    path: '/api/billing/monthly',       build: () => appWith('/api/billing', createBillingMonthlyRouter(f)) },
  { name: 'clientComments GET /:id/comments', path: '/api/clients/c1/comments', build: () => appWith('/api/clients', createClientCommentsRouter(f, f)) },
  { name: 'cpe GET /',                      path: '/api/cpe',                   build: () => appWith('/api/cpe', createCpeRouter(f, f, f, f, f, f)) },
  { name: 'creditNotes GET /credit-notes',  path: '/api/credit-notes',          build: () => appWith('/api', createCreditNotesRouter(f, f, f, f, f)) },
  { name: 'dashboard GET /stats',           path: '/api/dashboard/stats',       build: () => appWith('/api/dashboard', createDashboardRouter(f, f, f)) },
  { name: 'empresa GET /service-plans',     path: '/api/empresa/service-plans', build: () => appWith('/api/empresa', createEmpresaRouter(f, f, f, f, f, f, f, f, f, f)) },
  { name: 'financeHistory GET /history',    path: '/api/finance/history',       build: () => appWith('/api/finance', createFinanceHistoryRouter(f)) },
  { name: 'gpon GET /olts',                 path: '/api/gpon/olts',             build: () => appWith('/api/gpon', createGponRouter(f, f, f, f, f, f, f, f)) },
  { name: 'hardware GET /',                 path: '/api/hardware',              build: () => appWith('/api/hardware', createHardwareRouter(f, f, f, f)) },
  { name: 'leads GET /',                    path: '/api/leads',                 build: () => appWith('/api/leads', createLeadsRouter(f, f, f, f, f, f)) },
  { name: 'messages GET /',                 path: '/api/messages',              build: () => appWith('/api/messages', createMessagesRouter(f, f, f, f, f)) },
  { name: 'monitoring GET /stats',          path: '/api/monitoring/stats',      build: () => appWith('/api/monitoring', createMonitoringRouter(f, f, f, f)) },
  { name: 'networkSite GET /',              path: '/api/network-sites',         build: () => appWith('/api/network-sites', createNetworkSiteRouter(f, f, f, f, f)) },
  { name: 'notifications GET /',            path: '/api/notifications',         build: () => appWith('/api/notifications', createNotificationsRouter(f, f, f, f)) },
  { name: 'partner GET /',                  path: '/api/partners',              build: () => appWith('/api/partners', createPartnerRouter(f, f, f, f, f)) },
  { name: 'proformas GET /proformas',       path: '/api/proformas',             build: () => appWith('/api', createProformasRouter(f, f, f, f)) },
  { name: 'role GET /',                     path: '/api/roles',                 build: () => appWith('/api/roles', createRoleRouter(f, f, f, f, f)) },
  { name: 'settings GET /system',           path: '/api/settings/system',       build: () => appWith('/api/settings', createSettingsRouter(f, f, f, f, f, f, f, f, f)) },
  { name: 'tr069 GET /profiles',            path: '/api/tr069/profiles',        build: () => appWith('/api/tr069', createTr069Router(f, f, f, f, f, f, f)) },
  { name: 'ubicaciones GET /',              path: '/api/ubicaciones',           build: () => appWith('/api/ubicaciones', createUbicacionesRouter(f, f, f, f, f)) },
  { name: 'voz GET /categories',            path: '/api/voz/categories',        build: () => appWith('/api/voz', createVozRouter(f, f, f, f, f)) },
];

describe('async-error-sweep-2 — CRUD sin auth: un await desnudo que rechaza NO cuelga la request', () => {
  it.each(cases)('$name → 500 INTERNAL_ERROR inmediato con error de infra no mapeado', async ({ build, method = 'get', path, body }) => {
    const app = build();
    let req = request(app)[method](path).set('Cookie', AUTH_COOKIE);
    if (body !== undefined) req = req.send(body);
    const res = await expectNoHang(req);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  }, 10_000);
});
