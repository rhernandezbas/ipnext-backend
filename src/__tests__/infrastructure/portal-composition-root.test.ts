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
/**
 * L7 (fix wave) — regla del repo "tests sobre texto filtran comentarios": los
 * matches corren sobre el source EFECTIVO (sin lineas de comentario). Antes un
 * comentario que dijera `loginRateLimiter: ...` satisfacia el assert aunque el
 * wiring real lo hubiera perdido. Solo se filtran lineas-comentario completas
 * (`//`, `*`, `/*`) — no comments inline, para no romper strings con '//'.
 */
function stripCommentLines(src: string): string {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('customer-portal-api composition root — Fase 7 wiring', () => {
  let appSrc: string;
  let configSrc: string;

  beforeAll(() => {
    appSrc = stripCommentLines(readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8'));
    configSrc = stripCommentLines(readFileSync(join(__dirname, '..', '..', 'infrastructure', 'config.ts'), 'utf8'));
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

  it('imports the portal middlewares + the 4 portal rate limiters', () => {
    expect(appSrc).toContain("from './middleware/portalAuthMiddleware'");
    expect(appSrc).toContain("from './middleware/portalKillSwitchMiddleware'");
    expect(appSrc).toContain('createPortalLoginRateLimiter');
    // H3b (fix wave) — per-IP ceiling on /auth/login, wired explicitly.
    expect(appSrc).toContain('createPortalLoginIpRateLimiter');
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

  it('mounts createPortalRouter at /api/portal (L7: mount + router en UN solo match — no dos toContain sueltos)', () => {
    expect(appSrc).toMatch(/app\.use\(\s*'\/api\/portal'\s*,\s*createPortalRouter\(\{/);
  });

  it('createPortalRouter is wired with REAL use cases for auth (login/refresh/logout/change-password)', () => {
    const call = routerCall('createPortalRouter(');
    expect(call).toMatch(/portalLogin\s*[,:]/);
    expect(call).toMatch(/refreshPortalSession\s*[,:]/);
    expect(call).toMatch(/logoutPortal\s*[,:]/);
    expect(call).toMatch(/changePortalPassword\s*[,:]/);
  });

  it('createPortalRouter is wired with the kill-switch + all 4 rate limiters (none omitted to a silent default)', () => {
    const call = routerCall('createPortalRouter(');
    expect(call).toMatch(/killSwitch\s*[,:]/);
    expect(call).toMatch(/loginRateLimiter\s*[,:]/);
    expect(call).toMatch(/\bloginIpRateLimiter\s*[,:]/);
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

  it('mounts createPortalAccountsAdminRouter at /api/admin/portal-accounts (L7: un solo match)', () => {
    expect(appSrc).toMatch(/app\.use\(\s*'\/api\/admin\/portal-accounts'\s*,\s*createPortalAccountsAdminRouter\(\{/);
  });

  it('createPortalAccountsAdminRouter is wired with the 5 admin use cases + authProvider + sessionRepo + requirePortalManage', () => {
    const call = routerCall('createPortalAccountsAdminRouter(');
    expect(call).toMatch(/createPortalAccount\s*[,:]/);
    expect(call).toMatch(/regeneratePortalPassword\s*[,:]/);
    expect(call).toMatch(/setPortalAccountStatus\s*[,:]/);
    expect(call).toMatch(/deletePortalAccountAdmin\s*[,:]/);
    expect(call).toMatch(/listPortalAccounts\s*[,:]/);
    expect(call).toMatch(/authProvider\s*[,:]/);
    // H1 (fix wave) — stateful staff auth: the shared staff SessionRepository
    // must reach the router or a revoked session keeps operating the CRUD.
    expect(call).toMatch(/\bsessionRepo\s*[,:]/);
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

  it('DeleteMyPortalAccount is constructed with the portal account + session repos + hasher + DURABLE audit recorder (M5)', () => {
    const start = appSrc.indexOf('new DeleteMyPortalAccount(');
    expect(start).toBeGreaterThan(-1);
    const end = appSrc.indexOf(');', start);
    const call = appSrc.slice(start, end);
    expect(call).toMatch(/passwordHasher/);
    // M5 — el evento de borrado persiste en AuditEvent, no solo console.log.
    expect(call).toMatch(/createPortalAccountDeletionAuditRecorder\(\s*auditEventRepo\s*\)/);
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

    it('H4a: default "Soporte" — un área que EXISTE en el seed canónico (20260704000000_ticket_area_catalog); el default viejo "Atención al cliente" no está en ningún seed', () => {
      expect(configSrc).toContain('PORTAL_TICKET_AREA_NAME');
      expect(configSrc).toMatch(/portal:\s*\{[\s\S]{0,400}\|\|\s*'Soporte'/);
      // "Soporte" realmente existe en el seed canónico — el default no puede
      // volver a apuntar a un área fantasma.
      const seedSql = readFileSync(
        join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20260704000000_ticket_area_catalog', 'migration.sql'),
        'utf8',
      );
      expect(seedSql).toContain("'Soporte'");
    });

    it('H4b: usa || (no ??) — el secret sin setear llega como string vacío y DEBE caer al default', () => {
      const start = configSrc.indexOf('portal:');
      const block = configSrc.slice(start, configSrc.indexOf('},', start));
      expect(block).toMatch(/process\.env\.PORTAL_TICKET_AREA_NAME\s*\|\|/);
      expect(block).not.toMatch(/process\.env\.PORTAL_TICKET_AREA_NAME\s*\?\?/);
    });
  });

  describe('H4 — la perilla llega a prod (feature-sin-perilla guard)', () => {
    it('H4b: deploy.yml forwardea PORTAL_TICKET_AREA_NAME al container (sin esta línea la env var jamás existe en prod)', () => {
      const deployYml = readFileSync(
        join(__dirname, '..', '..', '..', '.github', 'workflows', 'deploy.yml'),
        'utf8',
      );
      expect(deployYml).toMatch(/-e PORTAL_TICKET_AREA_NAME="\$\{\{ secrets\.PORTAL_TICKET_AREA_NAME \}\}"/);
    });

    it('H4c: env.example documenta PORTAL_TICKET_AREA_NAME', () => {
      const envExample = readFileSync(join(__dirname, '..', '..', '..', 'env.example'), 'utf8');
      expect(envExample).toContain('PORTAL_TICKET_AREA_NAME');
    });
  });

  /**
   * portal-usage-metrics — mismo guard "feature sin perilla = inerte": el
   * handler de `GET /usage/:contractId` solo se monta si `getPortalUsageMetrics`
   * viene en los deps. Olvidarlo en app.ts mata el endpoint SIN un solo error de
   * compilación, y toda la suite queda en verde.
   */
  describe('portal-usage-metrics — "Mi consumo" llega a prod', () => {
    it('importa el use case y el adapter Prisma REAL (no el gemelo in-memory)', () => {
      expect(appSrc).toContain('GetPortalUsageMetrics');
      expect(appSrc).toContain("from '../adapters/prisma/PrismaUsageMetricsReader'");
      expect(appSrc).not.toContain('InMemoryUsageMetricsReader');
    });

    it('pasa `getPortalUsageMetrics` al createPortalRouter (sin esto la ruta no se monta)', () => {
      expect(appSrc).toMatch(/getPortalUsageMetrics,/);
    });
  });
});
