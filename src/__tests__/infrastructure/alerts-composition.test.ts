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
  let routesSrc: string;
  let apiKeyMiddlewareSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
    moduleSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'composeAlertsModule.ts'),
      'utf8',
    );
    routesSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'routes', 'alerts.routes.ts'),
      'utf8',
    );
    apiKeyMiddlewareSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'middleware', 'apiKeyMiddleware.ts'),
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

  // C5/C14 (Fase C, noc-alert-realtime) — el publisher dark de Fase A
  // (NoOpAlertEventPublisher) se reemplaza por el AlertEventBus REAL; la MISMA
  // instancia se comparte entre IngestAlert/AcknowledgeAlert (publisher) y el
  // router (eventBus para /stream) — design.md "la ruta SSE se suscribe al
  // bus, NUNCA al use-case".
  it('(e) publisher wired es AlertEventBus real (Fase C — reemplaza el NoOp dark de Fase A)', () => {
    expect(moduleSrc).toMatch(/new AlertEventBus\(\)/);
    expect(moduleSrc).not.toMatch(/new NoOpAlertEventPublisher\(\)/);
  });

  it('(j) IngestAlert/AcknowledgeAlert y el router comparten la MISMA instancia de eventBus', () => {
    expect(moduleSrc).toMatch(/new IngestAlert\(\s*repo\s*,\s*eventBus\s*\)/);
    // D — AcknowledgeAlert ahora toma un 3er param (telegramNotifier, D13) — el
    // regex ya NO exige `)` pegado a `eventBus`, solo que repo/eventBus sigan
    // siendo los primeros dos args, en ese orden.
    expect(moduleSrc).toMatch(/new AcknowledgeAlert\(\s*repo\s*,\s*eventBus\s*,/);
    expect(moduleSrc).toMatch(/eventBus(\s*,|\s*:\s*eventBus)/);
  });

  // D (`noc-alert-telegram`) — TelegramBotGateway saliente + webhook entrante.
  describe('Fase D — Telegram bidireccional', () => {
    it('(l) composeAlertsModule instancia HttpTelegramGateway + TelegramBotGateway + NotifyAlert', () => {
      expect(moduleSrc).toMatch(/new HttpTelegramGateway\(/);
      expect(moduleSrc).toMatch(/new TelegramBotGateway\(\s*telegramGateway\s*,/);
      expect(moduleSrc).toMatch(/new NotifyAlert\(/);
    });

    it('(m) NotifyAlert se suscribe al eventBus (mismo bus que SSE) y solo reacciona a "firing"', () => {
      expect(moduleSrc).toMatch(/eventBus\.subscribe\(/);
      expect(moduleSrc).toMatch(/notifyAlert\.execute\(/);
      expect(moduleSrc).toMatch(/event\.type\s*!==\s*'firing'/);
    });

    it('(n) AcknowledgeAlert recibe el MISMO telegramNotifier que se le pasa al router', () => {
      expect(moduleSrc).toMatch(/new AcknowledgeAlert\(\s*repo\s*,\s*eventBus\s*,\s*telegramNotifier\s*\)/);
      expect(moduleSrc).toMatch(/telegramGateway(\s*,|\s*:\s*telegramGateway)/);
    });

    it('(o) telegramBotToken/telegramChatId/telegramWebhookSecret salen de config.alerts', () => {
      expect(moduleSrc).toMatch(/config\.alerts\.telegramBotToken/);
      expect(moduleSrc).toMatch(/config\.alerts\.telegramChatId/);
      expect(moduleSrc).toMatch(/config\.alerts\.telegramWebhookSecret/);
    });

    it('(p) el webhook /telegram/webhook está montado en alerts.routes.ts con secret-token + callback ack:<id>', () => {
      expect(routesSrc).toMatch(/router\.post\(\s*['"]\/telegram\/webhook['"]/);
      expect(routesSrc).toMatch(/telegramWebhookAuth/);
      expect(routesSrc).toMatch(/\^ack:/);
      expect(routesSrc).toMatch(/acknowledgeAlert\.execute\(/);
      // El header en sí lo compara createTelegramSecretMiddleware (apiKeyMiddleware.ts).
      expect(apiKeyMiddlewareSrc).toMatch(/x-telegram-bot-api-secret-token/i);
      expect(apiKeyMiddlewareSrc).toMatch(/createTelegramSecretMiddleware/);
    });
  });

  it('(k) GET /stream montado con auth+readPerm, se suscribe al eventBus y hace heartbeat', () => {
    expect(routesSrc).toMatch(/router\.get\(\s*['"]\/stream['"]\s*,\s*auth\s*,\s*readPerm/);
    expect(routesSrc).toMatch(/eventBus\.subscribe\(/);
    expect(routesSrc).toMatch(/:\s*ping\\n\\n/);
    expect(routesSrc).toMatch(/text\/event-stream/);
    expect(routesSrc).toMatch(/X-Accel-Buffering/);
  });

  it('(f) ingestKey sale de config.alerts.fiberIngestKey (canónico, colector fibra)', () => {
    expect(moduleSrc).toMatch(/config\.alerts\.fiberIngestKey/);
  });

  it('(g) auth de las rutas RBAC = createAuthMiddleware(deps.authAdapter, deps.sessionRepo)', () => {
    expect(moduleSrc).toMatch(/createAuthMiddleware\(\s*deps\.authAdapter\s*,\s*deps\.sessionRepo\s*\)/);
  });

  // B8 (Fase B — noc-alert-grafana-source) — GrafanaWebhookSource wiring.
  it('(h) composeAlertsModule instancia GrafanaWebhookSource y lo pasa como grafanaSource', () => {
    expect(moduleSrc).toMatch(/new GrafanaWebhookSource\(\)/);
    expect(moduleSrc).toMatch(/grafanaSource(\s*,|\s*:\s*grafanaSource)/);
  });

  it('(i) ingestKey de grafana sale de config.alerts.grafanaIngestKey', () => {
    expect(moduleSrc).toMatch(/config\.alerts\.grafanaIngestKey/);
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
