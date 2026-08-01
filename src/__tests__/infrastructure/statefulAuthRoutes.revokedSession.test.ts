/**
 * fix/auth-stateful-routers — H1 fix wave, remaining ~34 routers + 2 deps-object routers.
 *
 * Bug: `createAuthMiddleware(authProvider, sessionRepo?)` only does the STATEFUL
 * (session-aware) check when `sessionRepo` is provided. ~36 router factories used to
 * build the middleware internally as `createAuthMiddleware(authProvider)` — no
 * `sessionRepo` — so a REVOKED staff session kept authenticating (falls back to the
 * legacy stateless JWT-only check) until the JWT itself expired (up to 8h). Example:
 * fire an employee, revoke their session from the panel, and their cookie keeps
 * operating billing/contracts/feature-flags/etc. for the rest of the day.
 *
 * Fix: every factory below now takes a `sessionRepo: SessionRepository | undefined`
 * parameter (added right after `authProvider`) and forwards it into
 * `createAuthMiddleware(authProvider, sessionRepo)`.
 *
 * This test proves the fix at the ROUTER level (does the factory's OWN internal
 * wiring forward sessionRepo into the auth check?), for EVERY migrated router, in one
 * parametrized sweep. It builds each router DIRECTLY (bypassing app.ts) with a REAL
 * `InMemorySessionRepository` holding one REVOKED session for a token the auth
 * provider otherwise accepts, and asserts 401 on a request carrying that cookie.
 *
 * IMPORTANT — every assertion here is a REVOKED-session request. Auth middleware
 * short-circuits with a 401 BEFORE the request ever reaches the router handler, so no
 * throwaway use-case stub (`u`) is ever invoked — there is no risk of hitting the
 * separate "async handler without try/catch hangs the request" class of bug that
 * other sweep tests (asyncErrorSweep*) are chasing. We are only proving the auth gate.
 *
 * Companion coverage:
 *  - `statefulAuthRoutes.architecture.test.ts` — static scan of
 *    `src/infrastructure/http/routes/*.ts`: fails if ANY router builds
 *    `createAuthMiddleware` with a single argument (closes the door for new routers).
 *  - `statefulAuthRoutes.appMounts.test.ts` — source-pins that `app.ts` actually
 *    supplies the REAL production `sessionRepo` (not `undefined`) to every one of
 *    these factories.
 *  - `billingRevokedSession.test.ts` / `taskAttachmentsRevokedSession.test.ts` — full
 *    end-to-end behavioural proof (login → revoke → 401) for two representative
 *    routers (positional-style and deps-object-style), with REAL use cases wired.
 *
 * Revert-probe: strip `sessionRepo` back out of any ONE router's `createAuthMiddleware`
 * call and ONLY that router's entry in this file goes red — named, not a generic
 * failure.
 */
import request from 'supertest';
import express, { Router, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';

import { InMemorySessionRepository } from '@infrastructure/adapters/in-memory/InMemorySessionRepository';
import { hashToken } from '@infrastructure/auth/sessionToken';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { AuthProvider, CookieConfig } from '@domain/ports/AuthProvider';
import type { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

import { createContractTechnologiesRouter } from '@infrastructure/http/routes/contractTechnologies.routes';
import { createContractServicesRouter } from '@infrastructure/http/routes/contractServices.routes';
import { createContractsRouter } from '@infrastructure/http/routes/contracts.routes';
import { createClientsRouter } from '@infrastructure/http/routes/clients.routes';
import { createBillingRouter } from '@infrastructure/http/routes/billing.routes';
import { createIClassStatusesRouter } from '@infrastructure/http/routes/iclassStatuses.routes';
import { createIClassDispatchPreviewRouter } from '@infrastructure/http/routes/iclassDispatchPreview.routes';
import { createIClassClosureRouter } from '@infrastructure/http/routes/iclass-closure.routes';
import { createIClassAdminRouter } from '@infrastructure/http/routes/iclass-admin.routes';
import { createGrVendedorMappingsRouter } from '@infrastructure/http/routes/grVendedorMappings.routes';
import { createGrSyncRouter } from '@infrastructure/http/routes/gr-sync.routes';
import { createGestionRealSyncRouter } from '@infrastructure/http/routes/gestionRealSync.routes';
import { createGestionRealIngestRouter } from '@infrastructure/http/routes/gestionRealIngest.routes';
import { createGestionRealRouter } from '@infrastructure/http/routes/gestionReal.routes';
import { createFeatureFlagsRouter } from '@infrastructure/http/routes/featureFlags.routes';
import { createDeviceTypeCatalogRouter } from '@infrastructure/http/routes/deviceTypeCatalog.routes';
import { createMaterialTypeCatalogRouter } from '@infrastructure/http/routes/materialTypeCatalog.routes';
import { createIClassTechnicianTeamsRouter } from '@infrastructure/http/routes/iclassTechnicianTeams.routes';
import { createIClassTeamsRouter } from '@infrastructure/http/routes/iclassTeams.routes';
import { createMessagingLabelsRouter } from '@infrastructure/http/routes/messagingLabels.routes';
import { createNewsRouter } from '@infrastructure/http/routes/news.routes';
import { createNocBroadcastRouter } from '@infrastructure/http/routes/nocBroadcast.routes';
import { createProjectsRouter } from '@infrastructure/http/routes/projects.routes';
import { createServiceCatalogRouter } from '@infrastructure/http/routes/serviceCatalog.routes';
import { createSchedulingRouter } from '@infrastructure/http/routes/scheduling.routes';
import { createTaskStageConfigRouter } from '@infrastructure/http/routes/taskStageConfig.routes';
import { createTaskPrioritiesRouter } from '@infrastructure/http/routes/taskPriorities.routes';
import { createTaskCategoriesRouter } from '@infrastructure/http/routes/taskCategories.routes';
import { createTaskTemplateRouter } from '@infrastructure/http/routes/taskTemplate.routes';
import { createTicketAreasRouter } from '@infrastructure/http/routes/ticketAreas.routes';
import { createWorkflowsRouter } from '@infrastructure/http/routes/workflows.routes';
import { createTicketStatusesRouter } from '@infrastructure/http/routes/ticketStatuses.routes';
import { createTicketSlaConfigRouter } from '@infrastructure/http/routes/ticketSlaConfig.routes';
import { createTicketsRouter } from '@infrastructure/http/routes/tickets.routes';
import { createNewsMediaRouter } from '@infrastructure/http/routes/newsMedia.routes';
import { createTaskAttachmentsRouter } from '@infrastructure/http/routes/taskAttachments.routes';

const STAFF_TOKEN = 'staff-token';

/** Accepts STAFF_TOKEN only — same pattern as settingsMountAuth.test.ts's FakeAuthProvider. */
class FakeAuthProvider implements AuthProvider {
  async login(): Promise<{ user: User; cookieValue: string; cookieOptions: CookieConfig }> {
    return {
      user: { id: 'staff-1', username: 'staff', email: 'staff@test.com' },
      cookieValue: STAFF_TOKEN,
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax', maxAge: 3600, path: '/' },
    };
  }
  logout(): { cookieOptions: CookieConfig } {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax', maxAge: 0, path: '/' } };
  }
  async getSession(token: string): Promise<User> {
    if (token !== STAFF_TOKEN) throw new Error('invalid');
    return { id: 'staff-1', username: 'staff', email: 'staff@test.com' };
  }
}

const authProvider = new FakeAuthProvider();
/** Pass-through middleware — never reached in this file (auth 401s first), kept only
 * because some factories call it (or a factory that returns it) synchronously while
 * building the router, before any HTTP request exists. */
const pass: RequestHandler = (_req, _res, next) => next();
const stubRequirePerm = (_module?: RbacModuleCode, _action?: PermissionAction): RequestHandler => pass;
/** Throwaway use-case stub. `never` is assignable to any parameter type, and since
 * every request in this file is rejected by the auth gate BEFORE the router handler
 * runs, `u` is never actually invoked. */
const u = {} as never;

interface Case {
  name: string;
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  mount: (sessionRepo: SessionRepository) => Router;
}

const cases: Case[] = [
  { name: 'contractTechnologies', method: 'get', path: '/contract-technologies',
    mount: (sessionRepo) => createContractTechnologiesRouter(authProvider, sessionRepo, u, u, u, u, u) },
  { name: 'contractServices', method: 'patch', path: '/contracts/x',
    mount: (sessionRepo) => createContractServicesRouter(authProvider, sessionRepo, stubRequirePerm, u, u, u, u, u) },
  { name: 'contracts', method: 'get', path: '/contracts/stats',
    mount: (sessionRepo) => createContractsRouter(authProvider, sessionRepo, u, u) },
  { name: 'clients', method: 'get', path: '/stats',
    // createClientsRouter's authProvider param is typed as the concrete JwtAuthAdapter
    // class (not the AuthProvider interface) — same `as never` throwaway-cast
    // technique as `u`, not a behavioral difference (FakeAuthProvider still IS an
    // AuthProvider; createAuthMiddleware only ever calls the interface methods).
    mount: (sessionRepo) => createClientsRouter(u, u, u, u, u, authProvider as never, sessionRepo, u, u, u) },
  { name: 'billing', method: 'get', path: '/summary',
    mount: (sessionRepo) => createBillingRouter(u, u, u, u, authProvider as never, sessionRepo) },
  { name: 'iclassStatuses', method: 'get', path: '/statuses',
    mount: (sessionRepo) => createIClassStatusesRouter(u, u, u, authProvider, sessionRepo, pass, pass) },
  { name: 'iclassDispatchPreview', method: 'get', path: '/dispatch-preview',
    mount: (sessionRepo) => createIClassDispatchPreviewRouter(u, authProvider, sessionRepo, pass) },
  { name: 'iclassClosure', method: 'post', path: '/result-codes/sync',
    mount: (sessionRepo) => createIClassClosureRouter(u, u, u, u, null, null, u, u, u, u, u, u, pass, authProvider, sessionRepo) },
  { name: 'iclassAdmin', method: 'post', path: '/so-types/sync',
    mount: (sessionRepo) => createIClassAdminRouter(u, u, authProvider, sessionRepo) },
  { name: 'grVendedorMappings', method: 'get', path: '/vendedor-mappings',
    mount: (sessionRepo) => createGrVendedorMappingsRouter(u, u, u, authProvider, sessionRepo, pass) },
  { name: 'grSync', method: 'post', path: '/reset-clients-cursor',
    mount: (sessionRepo) => createGrSyncRouter(authProvider, sessionRepo, u) },
  { name: 'gestionRealSync', method: 'get', path: '/config',
    mount: (sessionRepo) => createGestionRealSyncRouter(authProvider, sessionRepo, stubRequirePerm, u, u, u, u, u) },
  { name: 'gestionRealIngest', method: 'get', path: '/config',
    mount: (sessionRepo) => createGestionRealIngestRouter(authProvider, sessionRepo, u, u, u, u) },
  { name: 'gestionReal', method: 'get', path: '/sync/status',
    mount: (sessionRepo) => createGestionRealRouter(authProvider, sessionRepo, u) },
  { name: 'featureFlags', method: 'get', path: '/',
    mount: (sessionRepo) => createFeatureFlagsRouter(authProvider, sessionRepo, u, u, u, pass) },
  { name: 'deviceTypeCatalog', method: 'get', path: '/device-types',
    mount: (sessionRepo) => createDeviceTypeCatalogRouter(authProvider, sessionRepo, stubRequirePerm, u, u, u, u, u, u) },
  { name: 'materialTypeCatalog', method: 'get', path: '/material-types',
    mount: (sessionRepo) => createMaterialTypeCatalogRouter(authProvider, sessionRepo, stubRequirePerm, u, u, u, u, u, u) },
  { name: 'iclassTechnicianTeams', method: 'get', path: '/technician-teams',
    mount: (sessionRepo) => createIClassTechnicianTeamsRouter(u, u, authProvider, sessionRepo, pass, pass) },
  { name: 'iclassTeams', method: 'post', path: '/teams/sync',
    mount: (sessionRepo) => createIClassTeamsRouter(u, u, authProvider, sessionRepo, pass, pass) },
  { name: 'messagingLabels', method: 'get', path: '/',
    mount: (sessionRepo) => createMessagingLabelsRouter(authProvider, sessionRepo, stubRequirePerm, u, u, u, u) },
  { name: 'news', method: 'get', path: '/',
    mount: (sessionRepo) => createNewsRouter(authProvider, sessionRepo, stubRequirePerm, u, u, u, u, u, u, u, u, u, u, u) },
  { name: 'nocBroadcast', method: 'get', path: '/config',
    mount: (sessionRepo) => createNocBroadcastRouter(authProvider, sessionRepo, { read: pass, manage: pass }, u, u, u) },
  { name: 'projects', method: 'get', path: '/',
    mount: (sessionRepo) => createProjectsRouter(u, u, u, u, u, authProvider, sessionRepo) },
  { name: 'serviceCatalog', method: 'get', path: '/service-catalog',
    mount: (sessionRepo) => createServiceCatalogRouter(authProvider, sessionRepo, stubRequirePerm, u, u, u, u) },
  { name: 'scheduling', method: 'get', path: '/',
    mount: (sessionRepo) => createSchedulingRouter(u, u, u, u, u, u, authProvider, sessionRepo) },
  { name: 'taskStageConfig', method: 'get', path: '/',
    mount: (sessionRepo) => createTaskStageConfigRouter(authProvider, sessionRepo, { read: pass, manage: pass }, u, u, u, u) },
  { name: 'taskPriorities', method: 'get', path: '/task-priorities',
    mount: (sessionRepo) => createTaskPrioritiesRouter(authProvider, sessionRepo, u, u, u, u, u) },
  { name: 'taskCategories', method: 'get', path: '/task-categories',
    mount: (sessionRepo) => createTaskCategoriesRouter(authProvider, sessionRepo, u, u, u, u, u) },
  { name: 'taskTemplate', method: 'get', path: '/',
    mount: (sessionRepo) => createTaskTemplateRouter(u, u, u, u, u, authProvider, sessionRepo) },
  { name: 'ticketAreas', method: 'get', path: '/',
    mount: (sessionRepo) => createTicketAreasRouter(authProvider, sessionRepo, stubRequirePerm, u, u, u, u, u) },
  { name: 'workflows', method: 'get', path: '/workflows',
    mount: (sessionRepo) => createWorkflowsRouter(
      authProvider, sessionRepo, stubRequirePerm,
      // 20 required use cases: listWorkflows..deleteProjectType (none optional).
      u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u,
    ) },
  { name: 'ticketStatuses', method: 'get', path: '/',
    mount: (sessionRepo) => createTicketStatusesRouter(authProvider, sessionRepo, u, u, u, u, u) },
  { name: 'ticketSlaConfig', method: 'get', path: '/',
    mount: (sessionRepo) => createTicketSlaConfigRouter(authProvider, sessionRepo, stubRequirePerm, u, u) },
  { name: 'tickets', method: 'get', path: '/stats',
    mount: (sessionRepo) => createTicketsRouter(u, u, u, u, u, u, u, u, authProvider as never, sessionRepo) },
  { name: 'newsMedia', method: 'get', path: '/attachments/x/file',
    mount: (sessionRepo) => createNewsMediaRouter(u, { authProvider, sessionRepo, requireRead: pass, requireManage: pass }) },
  { name: 'taskAttachments', method: 'get', path: '/attachments/x/file',
    mount: (sessionRepo) => createTaskAttachmentsRouter(u, { authProvider, sessionRepo, requireRead: pass, requireWrite: pass }) },
];

describe('fix/auth-stateful-routers — revoked staff session -> 401 (parametrized, all 36 migrated routers)', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s: revoked session -> 401 (not 200)', async (_name, c) => {
    const sessionRepo = new InMemorySessionRepository();
    // A session that EXISTED and got explicitly revoked — the exact scenario from the
    // bug report (ex-employee's cookie kept working after an admin revoked it).
    sessionRepo.seed({
      tokenHash: hashToken(STAFF_TOKEN),
      revokedAt: new Date().toISOString(),
    });

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/r', c.mount(sessionRepo));

    const res = await request(app)[c.method]('/r' + c.path).set('Cookie', `auth_token=${STAFF_TOKEN}`);

    expect(res.status).toBe(401);
  });
});
