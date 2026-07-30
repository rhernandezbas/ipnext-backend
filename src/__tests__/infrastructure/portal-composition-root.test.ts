import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * customer-portal-api Fase 7 (task 7.1) — composition-root guard, molde
 * `finance-growth-composition-root.test.ts` / `inventory-composition-root.test.ts`.
 *
 * Pins that `app.ts` actually wires the portal (auth + self-service + admin CRUD)
 * with REAL Prisma-backed collaborators — not a fixture quietly filtering into
 * prod, and not a router mounted with half its optional deps missing (the exact
 * failure mode from "feature sin perilla = inerte": `portal.routes.ts`'s
 * self-service handlers only mount when their dep is truthy, so omitting one in
 * app.ts silently kills that endpoint with zero compile error).
 */
describe('customer-portal-api composition root — Fase 7 wiring', () => {
  let appSrc: string;
  let configSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
    configSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'config.ts'), 'utf8');
  });

  it('imports the portal routers', () => {
    expect(appSrc).toContain("from './routes/portal.routes'");
    expect(appSrc).toContain("from './routes/portalAccountsAdmin.routes'");
  });

  it('imports the portal Prisma adapters + JWT token service (not a fixture)', () => {
    expect(appSrc).toContain("from '../adapters/prisma/PrismaPortalAccountRepository'");
    expect(appSrc).toContain("from '../adapters/prisma/PrismaPortalSessionRepository'");
    expect(appSrc).toContain("from '../adapters/prisma/PrismaClientPortalLookup'");
    expect(appSrc).toContain("from '../adapters/jwt/JwtPortalTokenService'");
  });

  it('imports the portal middlewares + the 3 portal rate limiters', () => {
    expect(appSrc).toContain("from './middleware/portalAuthMiddleware'");
    expect(appSrc).toContain("from './middleware/portalKillSwitchMiddleware'");
    expect(appSrc).toContain('createPortalLoginRateLimiter');
    expect(appSrc).toContain('createPortalGeneralRateLimiter');
    expect(appSrc).toContain('createPortalTicketCreateRateLimiter');
  });

  it('imports all 11 self-service/auth use cases + the 5 admin use cases', () => {
    const portalUseCases = [
      'PortalLogin',
      'RefreshPortalSession',
      'LogoutPortal',
      'ChangePortalPassword',
      'GetPortalMe',
      'ListPortalInvoices',
      'ListPortalPlans',
      'ListPortalTasks',
      'ListPortalTickets',
      'GetPortalTicket',
      'CreatePortalTicket',
      'DeleteMyPortalAccount',
    ];
    for (const uc of portalUseCases) {
      expect(appSrc).toContain(`from '@application/use-cases/portal/${uc}'`);
    }
    const portalAdminUseCases = [
      'CreatePortalAccount',
      'RegeneratePortalPassword',
      'SetPortalAccountStatus',
      'DeletePortalAccountAdmin',
      'ListPortalAccounts',
    ];
    for (const uc of portalAdminUseCases) {
      expect(appSrc).toContain(`from '@application/use-cases/portal-admin/${uc}'`);
    }
  });

  // Slice-to-closing-`}));` pattern (fix-wave-2 lesson from finance-growth's
  // composition-root test): a fixed-length window silently blinds itself the
  // moment a comment shifts offsets. Slicing to the router's own closing
  // delimiter can't go stale that way.
  const routerCall = (marker: string): string => {
    const start = appSrc.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const end = appSrc.indexOf('}));', start);
    expect(end).toBeGreaterThan(start);
    return appSrc.slice(start, end);
  };

  it('mounts createPortalRouter at /api/portal', () => {
    expect(appSrc).toContain("'/api/portal'");
    expect(appSrc).toContain('createPortalRouter(');
  });

  it('createPortalRouter is wired with REAL use cases for auth (login/refresh/logout/change-password)', () => {
    const call = routerCall('createPortalRouter(');
    expect(call).toMatch(/portalLogin\s*[,:]/);
    expect(call).toMatch(/refreshPortalSession\s*[,:]/);
    expect(call).toMatch(/logoutPortal\s*[,:]/);
    expect(call).toMatch(/changePortalPassword\s*[,:]/);
  });

  it('createPortalRouter is wired with the kill-switch + all 3 rate limiters (none omitted to a silent default)', () => {
    const call = routerCall('createPortalRouter(');
    expect(call).toMatch(/killSwitch\s*[,:]/);
    expect(call).toMatch(/loginRateLimiter\s*[,:]/);
    expect(call).toMatch(/generalRateLimiter\s*[,:]/);
    expect(call).toMatch(/ticketCreateRateLimiter\s*[,:]/);
  });

  it('createPortalRouter is wired with ALL 8 optional self-service deps — none silently omitted (feature-sin-perilla guard)', () => {
    const call = routerCall('createPortalRouter(');
    const selfServiceDeps = [
      'getPortalMe',
      'listPortalInvoices',
      'listPortalPlans',
      'listPortalTasks',
      'listPortalTickets',
      'getPortalTicket',
      'createPortalTicket',
      'deleteMyPortalAccount',
    ];
    for (const dep of selfServiceDeps) {
      expect(call).toMatch(new RegExp(`\\b${dep}\\s*[,:]`));
    }
  });

  it('createPortalAuthMiddleware/createPortalKillSwitchMiddleware are constructed with REAL collaborators', () => {
    expect(appSrc).toMatch(/createPortalAuthMiddleware\(\s*\w+\s*,\s*\w+\s*\)/);
    expect(appSrc).toMatch(/createPortalKillSwitchMiddleware\(\s*settingsRepo\s*\)/);
  });

  it('mounts createPortalAccountsAdminRouter at /api/admin/portal-accounts', () => {
    expect(appSrc).toContain("'/api/admin/portal-accounts'");
    expect(appSrc).toContain('createPortalAccountsAdminRouter(');
  });

  it('createPortalAccountsAdminRouter is wired with the 5 admin use cases + authProvider + requirePortalManage', () => {
    const call = routerCall('createPortalAccountsAdminRouter(');
    expect(call).toMatch(/createPortalAccount\s*[,:]/);
    expect(call).toMatch(/regeneratePortalPassword\s*[,:]/);
    expect(call).toMatch(/setPortalAccountStatus\s*[,:]/);
    expect(call).toMatch(/deletePortalAccountAdmin\s*[,:]/);
    expect(call).toMatch(/listPortalAccounts\s*[,:]/);
    expect(call).toMatch(/authProvider\s*[,:]/);
    expect(call).toMatch(/requirePortalManage\s*[,:]/);
  });

  it('requirePortalManage is built via requirePerm(\'portal\', \'manage\') — the granular guard, not "solo autenticado"', () => {
    expect(appSrc).toMatch(/requirePerm\(\s*'portal'\s*,\s*'manage'\s*\)/);
  });

  it("CreatePortalTicket is constructed with config.portal.ticketAreaName — the configurable area name (design.md §6), not a hardcoded literal", () => {
    const start = appSrc.indexOf('new CreatePortalTicket(');
    expect(start).toBeGreaterThan(-1);
    const end = appSrc.indexOf(')', start);
    const call = appSrc.slice(start, end);
    expect(call).toMatch(/config\.portal\.ticketAreaName/);
  });

  it('DeleteMyPortalAccount is constructed with the portal account + session repos + hasher', () => {
    const start = appSrc.indexOf('new DeleteMyPortalAccount(');
    expect(start).toBeGreaterThan(-1);
    const end = appSrc.indexOf(')', start);
    const call = appSrc.slice(start, end);
    expect(call).toMatch(/passwordHasher/);
  });

  it('PortalLogin is constructed with a REAL PortalTokenService (JwtPortalTokenService), not a stub', () => {
    expect(appSrc).toMatch(/new JwtPortalTokenService\(\)/);
    const start = appSrc.indexOf('new PortalLogin(');
    expect(start).toBeGreaterThan(-1);
    const end = appSrc.indexOf(');', start);
    const call = appSrc.slice(start, end);
    expect(call).toMatch(/portalTokenService/);
  });

  describe('config.ts — PORTAL_TICKET_AREA_NAME is opt-in (NOT fail-fast)', () => {
    it('is NOT in REQUIRED_VARS', () => {
      const start = configSrc.indexOf('REQUIRED_VARS');
      const end = configSrc.indexOf('] as const', start);
      const requiredBlock = configSrc.slice(start, end);
      expect(requiredBlock).not.toContain('PORTAL_TICKET_AREA_NAME');
    });

    it('has a default of "Atención al cliente" so a deploy without the env var still boots and resolves an area', () => {
      expect(configSrc).toContain('PORTAL_TICKET_AREA_NAME');
      expect(configSrc).toMatch(/portal:\s*\{[\s\S]{0,200}Atención al cliente/);
    });
  });
});
