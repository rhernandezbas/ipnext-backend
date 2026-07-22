/**
 * messaging-bulk-composition.test.ts (F2, Batch 7, T7.5) — assertion estática
 * sobre `app.ts`, molde EXACTO `messaging-composition.test.ts` (F1, B6).
 * Anti-"feature muerta en prod" (lección W6): pinea que
 * `createMessagingBulkRouter` está montado en `/api/messaging/bulk` (spec
 * manda, NO `/api/messaging/campaigns` de design §7), que las 6 dependencias
 * (`ListMessagingTemplates`/`PreviewCampaignSegment`/`CreateCampaign`/
 * `campaignRunner`/`GetCampaign`/`ListCampaigns`) están cableadas, que
 * `CreateCampaign` recibe 3 args (contradicción #2 — el snippet de design §7
 * tenía 2, sin `templatePort`), que los guards RBAC `messaging.bulk`/
 * `messaging.templates` cubren la ventana de mount, y que `ReceiveChatwootWebhook`
 * (bloque F1) recibe `customerAdapter` como 6º arg (OPT-2 wireado, no muerto).
 *
 * rbac.ts / migraciones / errorHandler ya están pineados por
 * `messaging-bulk-migration.test.ts`/`messaging-bulk.errorHandler.test.ts`
 * (Batch 1/2) — no se repiten acá.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Messaging-bulk composition root (F2, Batch 7)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
  });

  it('(a) createMessagingBulkRouter está importado', () => {
    expect(appSrc).toMatch(/import\s*\{\s*createMessagingBulkRouter\s*\}\s*from\s*['"]\.\/routes\/messagingBulk\.routes['"]/);
  });

  it("(b) router montado en '/api/messaging/bulk' (spec manda, NO '/api/messaging/campaigns' de design §7)", () => {
    expect(appSrc).toMatch(/app\.use\(\s*['"]\/api\/messaging\/bulk['"]\s*,\s*createMessagingBulkRouter\(/);
    expect(appSrc).not.toMatch(/app\.use\(\s*['"]\/api\/messaging\/campaigns['"]/);
  });

  it('(c) TwilioContentGateway instanciado con config.twilio.{accountSid,authToken,messagingServiceSid}', () => {
    const idx = appSrc.indexOf('// ─── messaging-bulk (F2)');
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf("app.use('/api/messaging/bulk', createMessagingBulkRouter(", idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end);
    expect(window).toMatch(/new TwilioContentGateway\(\{/);
    expect(window).toMatch(/accountSid:\s*config\.twilio\.accountSid/);
    expect(window).toMatch(/authToken:\s*config\.twilio\.authToken/);
    expect(window).toMatch(/messagingServiceSid:\s*config\.twilio\.messagingServiceSid/);
  });

  it('(d) PrismaCampaignRepository + TokenBucketRateLimiter(ratePerSec: config.messagingBulk.ratePerSec) instanciados', () => {
    const idx = appSrc.indexOf('// ─── messaging-bulk (F2)');
    const end = appSrc.indexOf("app.use('/api/messaging/bulk', createMessagingBulkRouter(", idx);
    const window = appSrc.slice(idx, end);
    expect(window).toMatch(/new PrismaCampaignRepository\(\)/);
    expect(window).toMatch(/new TokenBucketRateLimiter\(\{\s*ratePerSec:\s*config\.messagingBulk\.ratePerSec\s*\}\)/);
  });

  it('(e) SendCampaign reusa customerAdapter (sin duplicar el port) + inyecta el projector (5º arg) + CampaignRunner con new PgAdvisoryLock()', () => {
    const idx = appSrc.indexOf('// ─── messaging-bulk (F2)');
    const end = appSrc.indexOf("app.use('/api/messaging/bulk', createMessagingBulkRouter(", idx);
    const window = appSrc.slice(idx, end);
    // messaging-bulk-inbox (F1, lección W6) — el projector NO debe quedar muerto:
    // SendCampaign lo recibe como 5º arg, o el bulk NUNCA deja rastro en el inbox.
    // chatwoot-hub-sendpath (D1/D4, B6) — MODIFIED: gana 7º/8º arg
    // (chatwootGatewayForBulk/featureFlagRepoForBulk, backoffOpts explícito
    // undefined como 6º) — pineado en detalle por
    // `messaging-composition.test.ts` (describe dedicado B6), acá sólo se
    // actualiza el regex para no quedar roto/desactualizado.
    expect(window).toMatch(
      /new SendCampaign\(campaignRepo,\s*customerAdapter,\s*templatePort,\s*rateLimiter,\s*campaignInboxProjector,\s*undefined,\s*chatwootGatewayForBulk,\s*featureFlagRepoForBulk\)/,
    );
    expect(window).toMatch(/new CampaignRunner\(sendCampaign,\s*campaignRepo,\s*new PgAdvisoryLock\(\)\)/);
  });

  it('(e2) PrismaCampaignInboxProjector importado e instanciado con los repos F1 + campaignRepo (anti-W6, proyección VIVA en prod)', () => {
    expect(appSrc).toMatch(
      /import\s*\{\s*PrismaCampaignInboxProjector\s*\}\s*from\s*['"]\.\.\/adapters\/prisma\/PrismaCampaignInboxProjector['"]/,
    );
    const idx = appSrc.indexOf('// ─── messaging-bulk (F2)');
    const end = appSrc.indexOf("app.use('/api/messaging/bulk', createMessagingBulkRouter(", idx);
    const window = appSrc.slice(idx, end);
    expect(window).toMatch(
      /const campaignInboxProjector = new PrismaCampaignInboxProjector\(\s*new PrismaConversationRepository\(\),\s*new PrismaChatMessageRepository\(\),\s*campaignRepo,?\s*\)/,
    );
  });

  it('(f) las 6 dependencias wired dentro de la MISMA llamada de mount', () => {
    const idx = appSrc.indexOf("app.use('/api/messaging/bulk', createMessagingBulkRouter(");
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('));', idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end + '));'.length);

    expect(window).toMatch(/new ListMessagingTemplates\(templatePort\)/);
    // manual-recipients — Preview y Create reciben customerAdapter TAMBIÉN como
    // ManualRecipientSource (misma instancia): 2 args en Preview, 4 en Create.
    // bulk-task-recipients (D3/D5, B6) — MODIFIED: Preview/Create ganan 2 args
    // OPCIONALES más AL FINAL (taskRecipientSource/taskStageConfigRepo, 5to
    // dominio) — anti-W6, sin esto el dominio "Tarea" queda cableado a la nada
    // en prod (lección ya citada en el propio design).
    expect(window).toMatch(/new PreviewCampaignSegment\(customerAdapter,\s*customerAdapter,\s*taskRecipientSource,\s*taskStageConfigRepo\)/);
    expect(window).toMatch(/new CreateCampaign\(campaignRepo,\s*customerAdapter,\s*templatePort,\s*customerAdapter,\s*taskRecipientSource,\s*taskStageConfigRepo\)/);
    expect(window).toMatch(/^\s*campaignRunner,\s*$/m);
    expect(window).toMatch(/new GetCampaign\(campaignRepo\)/);
    expect(window).toMatch(/new ListCampaigns\(campaignRepo\)/);
  });

  // messaging-bulk v1.1 (preview modal paginado) — anti-W6: ListSegmentRecipients
  // NO debe quedar muerto (instanciado pero nunca pasado al router).
  //
  // bulk-csv-recipients (DET-1) — gana el 2do arg `customerAdapter`
  // (`manualRecipientSource`, cierra la deuda F4: solo-manual/solo-CSV en
  // `/segment/recipients` deja de ser 400).
  //
  // bulk-task-recipients (D3/D5, B6) — MODIFIED: gana los mismos 2 args
  // opcionales al final que Preview/Create (taskRecipientSource/taskStageConfigRepo).
  it('(f2) v1.1/bulk-csv-recipients/bulk-task-recipients: ListSegmentRecipients instanciado con customerAdapter x2 + taskRecipientSource + taskStageConfigRepo Y pasado dentro de la MISMA llamada de mount', () => {
    const idx = appSrc.indexOf("app.use('/api/messaging/bulk', createMessagingBulkRouter(");
    const end = appSrc.indexOf('));', idx);
    const window = appSrc.slice(idx, end + '));'.length);
    expect(window).toMatch(/new ListSegmentRecipients\(customerAdapter,\s*customerAdapter,\s*taskRecipientSource,\s*taskStageConfigRepo\)/);
  });

  // bulk-task-recipients (D2, D6, B6) — anti-W6: los 2 adapters Prisma del 5to
  // dominio deben existir como instancias REALES dentro del bloque bulk, no
  // solo mencionadas en los constructores de arriba (eso probaría un typo que
  // referencia una variable inexistente, no wiring real).
  it('(o) bulk-task-recipients: PrismaTaskRecipientSource + PrismaTaskStageRecipientConfigRepository instanciados en el bloque bulk (scope-local, anti-interleave con el bloque de config nuevo)', () => {
    expect(appSrc).toMatch(
      /import\s*\{\s*PrismaTaskRecipientSource\s*\}\s*from\s*['"]\.\.\/adapters\/prisma\/PrismaTaskRecipientSource['"]/,
    );
    expect(appSrc).toMatch(
      /import\s*\{\s*PrismaTaskStageRecipientConfigRepository\s*\}\s*from\s*['"]\.\.\/adapters\/prisma\/PrismaTaskStageRecipientConfigRepository['"]/,
    );
    const idx = appSrc.indexOf('// ─── messaging-bulk (F2)');
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf("app.use('/api/messaging/bulk', createMessagingBulkRouter(", idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end);
    expect(window).toMatch(/const taskRecipientSource = new PrismaTaskRecipientSource\(\)/);
    expect(window).toMatch(/const taskStageConfigRepo = new PrismaTaskStageRecipientConfigRepository\(\)/);
  });

  it('(g) CreateCampaign recibe 3 args — contradicción #2 (design §7 original tenía 2, sin templatePort)', () => {
    const idx = appSrc.indexOf("app.use('/api/messaging/bulk', createMessagingBulkRouter(");
    const end = appSrc.indexOf('));', idx);
    const window = appSrc.slice(idx, end + '));'.length);
    expect(window).toMatch(/new CreateCampaign\([^)]*,[^)]*,[^)]*\)/);
  });

  it('(h) guards RBAC messaging.bulk + messaging.templates y auth STATEFUL dentro de la ventana de mount', () => {
    const idx = appSrc.indexOf("app.use('/api/messaging/bulk', createMessagingBulkRouter(");
    const end = appSrc.indexOf('));', idx);
    const window = appSrc.slice(idx, end + '));'.length);

    expect(window).toMatch(/requirePerm\('messaging',\s*'bulk'\)/);
    expect(window).toMatch(/requirePerm\('messaging',\s*'templates'\)/);
    expect(window).toMatch(/createAuthMiddleware\(authAdapter,\s*sessionRepo\)/);
  });

  it('(i) ReceiveChatwootWebhook (bloque F1) recibe customerAdapter como 6º arg — OPT-2 NO queda muerto en prod', () => {
    const idx = appSrc.indexOf("app.use('/api/messaging', createMessagingRouter(");
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('));', idx);
    const window = appSrc.slice(idx, end + '));'.length);
    // conversation-events (Ola 2) — customerAdapter (6º) sigue presente; ahora seguido del
    // conversationEventRepo (7º), sin romper OPT-2.
    expect(window).toMatch(/new ReceiveChatwootWebhook\([^)]*,\s*customerAdapter,\s*conversationEventRepo\)/);
  });

  it('(j) PrismaCampaignRepository importado desde el adapter correcto', () => {
    expect(appSrc).toMatch(/import\s*\{\s*PrismaCampaignRepository\s*\}\s*from\s*['"]\.\.\/adapters\/prisma\/PrismaCampaignRepository['"]/);
  });

  // ── bulk-granular-perms — re-chequeo en el envío + resolver de acciones ───────
  it('(l) bulk-granular-perms: AuthorizeCampaignSend(campaignRepo) + resolveBulkActions wired en la MISMA llamada de mount', () => {
    const idx = appSrc.indexOf("app.use('/api/messaging/bulk', createMessagingBulkRouter(");
    const end = appSrc.indexOf('));', idx);
    const window = appSrc.slice(idx, end + '));'.length);
    expect(window).toMatch(/new AuthorizeCampaignSend\(campaignRepo\)/);
    expect(window).toMatch(/resolveBulkActions,/);
  });

  it('(m) bulk-granular-perms: AuthorizeCampaignSend importado + resolveBulkActions bypassa super_admin con ["*"]', () => {
    expect(appSrc).toMatch(
      /import\s*\{\s*AuthorizeCampaignSend\s*\}\s*from\s*['"]@application\/use-cases\/messaging\/AuthorizeCampaignSend['"]/,
    );
    // el resolver mapea super_admin → ['*'] y filtra las acciones del módulo messaging.
    expect(appSrc).toMatch(/return \['\*'\]/);
    expect(appSrc).toMatch(/p\.moduleCode === 'messaging'/);
  });

  // ── F3 (defense-in-depth) — el sentinel '*' SOLO puede venir de la rama super_admin ─
  it('(n) F3: el resolver data-driven filtra el sentinel del set de acciones (no lo deja colar de un action literal)', () => {
    expect(appSrc).toMatch(
      /import\s*\{[^}]*BULK_SUPER_ADMIN_SENTINEL[^}]*\}\s*from\s*['"]@domain\/services\/bulkRecipientAuthorization['"]/,
    );
    // tras mapear las acciones del módulo messaging, se descarta el sentinel.
    expect(appSrc).toMatch(/\.filter\(\s*\(a\)\s*=>.*!==\s*BULK_SUPER_ADMIN_SENTINEL/);
  });

  // ── bulk-csv-recipients (fix wave, C1) — 413 ANTES de la ruta ────────────────
  // El global `app.use(express.json())` (default 100kb) corría ANTES de cualquier
  // override para /api/messaging/bulk: un CSV real (~2000 contactos ya pasan
  // 100kb; el cap de negocio es 5000) recibía 413 del body-parser ANTES de llegar
  // al router — /segment/preview, /segment/recipients y /campaigns quedaban
  // inservibles, el 422 TOO_MANY_MANUAL_CONTACTS inalcanzable. Fix: molde EXACTO
  // del path-scoped parser de tickets (:875)/messaging-inbox (:883) — un
  // `express.json({ limit: '2mb' })` scoped a `/api/messaging/bulk` ANTES del
  // global. `messagingBulk.dualParser.e2e.test.ts` prueba esto FUNCIONALMENTE
  // (un payload real >100kb NO 413ea bajo el PROD ORDER real).
  it('(k) C1 — path-scoped 2mb JSON parser para /api/messaging/bulk registrado ANTES del express.json() global (guard del 413)', () => {
    const scopedIdx = appSrc.indexOf("app.use('/api/messaging/bulk', express.json({ limit: '2mb' }));");
    const globalIdx = appSrc.indexOf('app.use(express.json());');
    expect(scopedIdx).toBeGreaterThan(-1);
    expect(globalIdx).toBeGreaterThan(-1);
    expect(scopedIdx).toBeLessThan(globalIdx);
  });
});
