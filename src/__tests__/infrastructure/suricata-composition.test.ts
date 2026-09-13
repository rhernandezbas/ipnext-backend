/**
 * suricata-tickets-mirror (task A.7, updated Fase D task D.7, Fase E, Fase F
 * task F.4, D8) — composition-root test, molde
 * `external-bulk-messaging-composition.test.ts` (a) "assertions estáticas".
 *
 * `composeSuricataModule` (panel interno) implementa TODAS sus rutas desde
 * Fase F: `POST /tickets/:id/reply` (Fase E) + `GET /tickets`, `GET
 * /tickets/:id`, `GET /areas`, `GET /kpis`, `PATCH /tickets/:id/assignee`
 * (Fase F) — ya no queda ningún stub 501. Fase D reemplazó el Slice 0 dark
 * del endpoint EXTERNO por la key dedicada real + `machineActorMiddleware` —
 * la invariante de ORDEN (D8) sigue siendo la misma: si el mount de
 * `/api/external/v1/suricata` quedara DESPUÉS del mount GLOBAL
 * `/api/external/v1`, la key GLOBAL interceptaría el prefijo dedicado y
 * `config.suricata.externalApiKey` nunca se evaluaría — mismo incidente ya
 * documentado para `external-bulk-messaging`. Por eso este test lee el FUENTE
 * de `app.ts` (ningún test de este repo importa `app.ts` — ver la nota de
 * `assistant-composition.test.ts` / `external-bulk-messaging-composition.test.ts`
 * sobre por qué: levantaría media aplicación).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('suricata-tickets-mirror composition root — assertions estáticas (D8)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
  });

  it('composeSuricataModule y composeSuricataExternalModule están importados', () => {
    expect(appSrc).toMatch(
      /import\s*\{\s*composeSuricataModule\s*\}\s*from\s*['"]\.\/composeSuricataModule['"]/,
    );
    expect(appSrc).toMatch(
      /import\s*\{\s*composeSuricataExternalModule\s*\}\s*from\s*['"]\.\/composeSuricataExternalModule['"]/,
    );
  });

  it('el mount interno existe y pasa authAdapter/sessionRepo/requirePerm (D8, sin re-derivar un 2º rbacUserRepo)', () => {
    expect(appSrc).toMatch(
      /app\.use\('\/api\/suricata',\s*composeSuricataModule\(\{\s*authAdapter,\s*sessionRepo,\s*requirePerm,\s*replyToSuricataTicket,\s*featureFlags:\s*suricataInternalFeatureFlagRepo,\s*listSuricataTickets,\s*getSuricataTicketDetail,\s*computeSuricataKpis,\s*setSuricataAssignee,\s*areaRepo:\s*suricataInternalAreaRepo,\s*attachmentRepo:\s*suricataInternalAttachmentRepo,\s*fileStorage:\s*taskPhotoStorage,?\s*\}\)\)/,
    );
  });

  it('Fase F — las 4 use cases del panel se instancian con el rbacUserRepo COMPARTIDO (no uno nuevo)', () => {
    expect(appSrc).toMatch(
      /new ListSuricataTickets\(\s*suricataInternalTicketRepo,\s*suricataInternalVerdictRepo,\s*suricataInternalAreaRepo,\s*rbacUserRepo,?\s*\)/,
    );
    expect(appSrc).toMatch(
      /new GetSuricataTicketDetail\(\s*suricataInternalTicketRepo,\s*suricataInternalMessageRepo,\s*suricataInternalAttachmentRepo,\s*suricataInternalVerdictRepo,\s*suricataInternalAreaRepo,\s*rbacUserRepo,?\s*\)/,
    );
    expect(appSrc).toContain('new ComputeSuricataKpis(suricataInternalTicketRepo, suricataInternalVerdictRepo)');
    expect(appSrc).toContain('new SetSuricataAssignee(suricataInternalTicketRepo, rbacUserRepo)');
  });

  it('la Fase E wirea el guard conservador `UnavailableSuricataReplyPort` — NUNCA `PlaywrightSuricataReply` (Fase J pendiente)', () => {
    expect(appSrc).toContain('new UnavailableSuricataReplyPort()');
    expect(appSrc).not.toContain('new PlaywrightSuricataReply(');
  });

  it('Fase G — el wiring INTERNO de `ReplyToSuricataTicket` queda BYTE-FOR-BYTE sin tocar (EXTREPLY-2: esta fase no toca ese path en absoluto)', () => {
    expect(appSrc).toMatch(
      /const replyToSuricataTicket = new ReplyToSuricataTicket\(\s*suricataInternalTicketRepo,\s*suricataReplyAuditRepo,\s*new UnavailableSuricataReplyPort\(\),\s*\);/,
    );
  });

  it('el mount interno queda montado DESPUÉS de /api/assistant (D8: "INMEDIATAMENTE DESPUÉS del mount de /api/assistant")', () => {
    const assistantIdx = appSrc.indexOf("app.use('/api/assistant',");
    const internalIdx = appSrc.indexOf("app.use('/api/suricata',");

    expect(assistantIdx).toBeGreaterThan(-1);
    expect(internalIdx).toBeGreaterThan(-1);
    expect(assistantIdx).toBeLessThan(internalIdx);
  });

  it('el marcador de fin del mount interno existe (ancla para futuras ventanas recortadas, molde fix wave F1 R3 #5)', () => {
    expect(appSrc).toContain('[suricata-internal-mount-end]');
  });

  it('el marcador de fin del mount externo existe', () => {
    expect(appSrc).toContain('[suricata-external-mount-end]');
  });

  it('CRÍTICO — el mount de /api/external/v1/suricata queda ANTES (índice MENOR) que el mount global /api/external/v1', () => {
    const suricataExternalIdx = appSrc.indexOf("app.use('/api/external/v1/suricata',");
    const globalExternalIdx = appSrc.indexOf("app.use('/api/external/v1',");

    expect(suricataExternalIdx).toBeGreaterThan(-1);
    expect(globalExternalIdx).toBeGreaterThan(-1);
    expect(suricataExternalIdx).toBeLessThan(globalExternalIdx);
  });

  it('el mount externo aplica createApiKeyMiddleware(config.suricata.externalApiKey) (Fase D, D8)', () => {
    expect(appSrc).toMatch(
      /app\.use\(\s*'\/api\/external\/v1\/suricata',\s*createApiKeyMiddleware\(config\.suricata\.externalApiKey\)/,
    );
  });

  it('el mount externo aplica machineActorMiddleware(rbacUserRepo, API_SURICATA_USER_LOGIN) (Fase D, D8, auditoría)', () => {
    expect(appSrc).toContain('machineActorMiddleware(rbacUserRepo, API_SURICATA_USER_LOGIN)');
  });

  it('Fase G — el mount EXTERNO construye `BotpressReplyAdapter`/`SendAutonomousSuricataReply` (plain HTTP, sin registry/bootstrap)', () => {
    expect(appSrc).toMatch(
      /import\s*\{\s*BotpressReplyAdapter\s*\}\s*from\s*['"]@infrastructure\/adapters\/suricata\/BotpressReplyAdapter['"]/,
    );
    expect(appSrc).toMatch(
      /import\s*\{\s*SendAutonomousSuricataReply\s*\}\s*from\s*['"]@application\/use-cases\/suricata\/SendAutonomousSuricataReply['"]/,
    );
    expect(appSrc).toContain('new BotpressReplyAdapter(suricataReplyBrowserSession)');
    expect(appSrc).toContain('new UnavailableBotpressReplyPort()');
    expect(appSrc).toMatch(/const sendAutonomousSuricataReply = new SendAutonomousSuricataReply\(/);
    // Feeds the EXTERNAL compose call, not the internal one.
    expect(appSrc).toMatch(/closeSuricataTicket,\s*sendAutonomousSuricataReply,\s*\}\),\s*\);/);
  });
});

/**
 * suricata-bot-autonomous-actions (Phase A, task A.15, design D7, this
 * project's own real incident today) — import-hygiene invariant:
 * `composeSuricataExternalModule.ts` must have ZERO runtime imports of
 * `config`, `sharedSuricataSession`, or any `bootstrap*` module. Pulling any
 * of those transitively runs `config.ts`'s fail-fast env validator at import
 * time (a real `process.exit(1)` inside a Jest worker) — the exact incident
 * that already broke two route test suites earlier today. The four
 * Playwright drivers are built from `getSharedSuricataSession()`, which
 * itself imports `config` — so the isolation boundary is
 * `bootstrapSuricataActionPorts.ts` (the ONLY file allowed to import either),
 * never the compose module. Re-run at H.2 against the FINAL file, after
 * Phases D-G add real driver construction to the bootstrap file.
 */
describe('suricata-bot-autonomous-actions — import-hygiene invariant (task A.15/H.2, design D7)', () => {
  let composeExternalSrc: string;

  beforeAll(() => {
    composeExternalSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'composeSuricataExternalModule.ts'),
      'utf8',
    );
  });

  /** Solo lineas de import/export-from efectivas — comentarios fuera (regla "tests sobre texto filtran comentarios"). */
  function effectiveImportSpecs(src: string): string[] {
    const effective = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    const importFrom = /(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/g;
    const specs: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importFrom.exec(effective)) !== null) {
      specs.push(match[1] as string);
    }
    return specs;
  }

  it('composeSuricataExternalModule.ts tiene CERO imports de config/sharedSuricataSession/bootstrap*', () => {
    const specs = effectiveImportSpecs(composeExternalSrc);
    const offenders = specs.filter(
      (spec) =>
        /(?:^|\/)config$/.test(spec) ||
        /sharedSuricataSession$/.test(spec) ||
        /\/bootstrap[^/]*$/.test(spec),
    );
    expect(offenders).toEqual([]);
  });
});
