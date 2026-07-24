/**
 * alerts-composition.test.ts — assertion estática (patrón actions-composition /
 * pppoe-composition / gigared-composition). Anti-"feature muerta": pinea el
 * wiring de composeAlertsModule() en app.ts SIN inflar el God Object (A24,
 * molde lección W6). El wiring pesado vive en composeAlertsModule.ts, aparte.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Alerts composition root (noc-alerts-hub Fase A)', () => {
  let appSrc: string;
  let moduleSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
    moduleSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'composeAlertsModule.ts'),
      'utf8',
    );
  });

  it('(a) composeAlertsModule está importado en app.ts', () => {
    expect(appSrc).toMatch(/import\s*\{\s*composeAlertsModule\s*\}\s*from\s*['"]\.\/composeAlertsModule['"]/);
  });

  it("(b) router montado en '/api/alerts' vía composeAlertsModule(", () => {
    expect(appSrc).toMatch(/app\.use\(\s*['"]\/api\/alerts['"]\s*,\s*composeAlertsModule\(/);
  });

  it('(c) el mount pasa authAdapter, sessionRepo y requirePerm (ventana acotada al call)', () => {
    const idx = appSrc.indexOf("app.use('/api/alerts'");
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('));', idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end + '));'.length);
    expect(window).toMatch(/authAdapter/);
    expect(window).toMatch(/sessionRepo/);
    expect(window).toMatch(/requirePerm/);
  });

  it('(d) composeAlertsModule instancia PrismaNocAlertRepository + los 3 use-cases', () => {
    expect(moduleSrc).toMatch(/new PrismaNocAlertRepository\(\)/);
    expect(moduleSrc).toMatch(/new IngestAlert\(/);
    expect(moduleSrc).toMatch(/new ListAlerts\(/);
    expect(moduleSrc).toMatch(/new AcknowledgeAlert\(/);
  });

  it('(e) publisher wired es NoOpAlertEventPublisher (Fase A dark — AlertEventBus es Fase C)', () => {
    expect(moduleSrc).toMatch(/new NoOpAlertEventPublisher\(\)/);
  });

  it('(f) ingestKey sale de config.alerts.fiberIngestKey (canónico, colector fibra)', () => {
    expect(moduleSrc).toMatch(/config\.alerts\.fiberIngestKey/);
  });

  it('(g) auth de las rutas RBAC = createAuthMiddleware(deps.authAdapter, deps.sessionRepo)', () => {
    expect(moduleSrc).toMatch(/createAuthMiddleware\(\s*deps\.authAdapter\s*,\s*deps\.sessionRepo\s*\)/);
  });
});

describe("RBAC — 'monitoring' + 'acknowledge_alert' YA existen (no requiere seed nuevo)", () => {
  it("rbac.ts declara la action 'acknowledge_alert' en KNOWN_ACTIONS", () => {
    const rbacSrc = readFileSync(join(__dirname, '..', '..', 'domain', 'entities', 'rbac.ts'), 'utf8');
    expect(rbacSrc).toMatch(/'acknowledge_alert'/);
  });

  it("rbac.ts declara 'monitoring' en RBAC_MODULES", () => {
    const rbacSrc = readFileSync(join(__dirname, '..', '..', 'domain', 'entities', 'rbac.ts'), 'utf8');
    expect(rbacSrc).toMatch(/'monitoring',/);
  });
});

describe('Migración 20261020000000_noc_alert — seed idempotente de flags', () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(
      join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20261020000000_noc_alert', 'migration.sql'),
      'utf8',
    );
  });

  it('crea la tabla NocAlert con @@unique(source, fingerprint)', () => {
    expect(sql).toMatch(/CREATE TABLE "NocAlert"/);
    expect(sql).toMatch(/UNIQUE INDEX "NocAlert_source_fingerprint_key" ON "NocAlert"\("source", "fingerprint"\)/);
  });

  it('seedea noc-alerts-hub-enabled=true y noc-alerts-telegram-send=false', () => {
    expect(sql).toMatch(/'noc-alerts-hub-enabled',\s*true/);
    expect(sql).toMatch(/'noc-alerts-telegram-send',\s*false/);
  });

  it('ambos INSERT de FeatureFlag son idempotentes (ON CONFLICT DO NOTHING)', () => {
    const flagInserts = sql.match(/INSERT INTO "FeatureFlag"/g) ?? [];
    const conflicts = sql.match(/ON CONFLICT DO NOTHING/g) ?? [];
    expect(flagInserts).toHaveLength(2);
    // +1 conflict-free CREATE TABLE doesn't add ON CONFLICT — only the 2 FeatureFlag inserts do.
    expect(conflicts.length).toBeGreaterThanOrEqual(2);
  });
});
