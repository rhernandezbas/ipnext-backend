/**
 * messaging-composition.test.ts (batch B6) — assertion estática sobre app.ts,
 * patrón `actions-composition.test.ts`. Anti-"feature muerta" / anti-"wiring roto
 * en silencio" (lección W6/#38: params opcionales + tests que inyectan su propio
 * wiring = CI verde / prod muerto): pinea que el router /api/messaging está
 * montado, que el raw-body scoped parser del webhook corre ANTES del
 * `express.json()` global (crítico — si se invierte, `req.rawBody` nunca se
 * captura y HOOK-1/HMAC rompe en silencio en prod), y que los 6 use cases +
 * el gateway + los 3 repos Prisma están cableados con las RBAC guards correctas.
 *
 * rbac.ts / migraciones / errorHandler ya están pineados por
 * `messaging-migration.test.ts` (B1) — no se repiten acá.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';

describe('Messaging composition root (messaging-inbox F1, B6)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
  });

  it('(a) createMessagingRouter está importado', () => {
    expect(appSrc).toMatch(/import\s*\{\s*createMessagingRouter\s*\}\s*from\s*['"]\.\/routes\/messaging\.routes['"]/);
  });

  it("(b) router montado en '/api/messaging'", () => {
    expect(appSrc).toMatch(/app\.use\(\s*['"]\/api\/messaging['"]\s*,\s*createMessagingRouter\(/);
  });

  it(
    '(c) CRÍTICO — el raw-body parser de /api/messaging/webhook está registrado ANTES del ' +
      'express.json() global (si se invierte, req.rawBody nunca se captura y el HMAC rompe en silencio)',
    () => {
      const webhookParserIdx = appSrc.indexOf("app.use('/api/messaging/webhook', rawBodyJsonParser())");
      const globalJsonIdx = appSrc.indexOf('app.use(express.json());');

      expect(webhookParserIdx).toBeGreaterThan(-1);
      expect(globalJsonIdx).toBeGreaterThan(-1);
      expect(webhookParserIdx).toBeLessThan(globalJsonIdx);
    },
  );

  it('(d) rawBodyJsonParser + createChatwootSignatureMiddleware importados del middleware B5', () => {
    expect(appSrc).toMatch(
      /import\s*\{\s*createChatwootSignatureMiddleware,\s*rawBodyJsonParser\s*\}\s*from\s*['"]\.\/middleware\/chatwootSignatureMiddleware['"]/,
    );
  });

  it('(e) guards RBAC read+send y auth STATEFUL dentro de la llamada de mount (ventana acotada al call)', () => {
    const idx = appSrc.indexOf("app.use('/api/messaging', createMessagingRouter(");
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('));', idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end + '));'.length);

    expect(window).toMatch(/requirePerm\('messaging',\s*'read'\)/);
    expect(window).toMatch(/requirePerm\('messaging',\s*'send'\)/);
    expect(window).toMatch(/createAuthMiddleware\(authAdapter,\s*sessionRepo\)/);
    expect(window).toMatch(/createChatwootSignatureMiddleware\(\)/);
  });

  it('(f) adapters Prisma del mirror instanciados (Conversation + ChatMessage + WebhookDelivery)', () => {
    expect(appSrc).toMatch(/new PrismaConversationRepository\(\)/);
    expect(appSrc).toMatch(/new PrismaChatMessageRepository\(\)/);
    expect(appSrc).toMatch(/new PrismaWebhookDeliveryRepository\(\)/);
  });

  it('(g) HttpChatwootGateway instanciado con config.chatwoot (opt-in, boot nunca falla)', () => {
    expect(appSrc).toMatch(/new HttpChatwootGateway\(\{/);
    expect(appSrc).toMatch(/baseUrl:\s*config\.chatwoot\.baseUrl/);
    expect(appSrc).toMatch(/apiToken:\s*config\.chatwoot\.apiToken/);
  });

  it('(h) los 6 use cases wired (ListMessages aliased ListChatMessages — colisión con el ListMessages de notifications-inbox :318)', () => {
    expect(appSrc).toMatch(/new ReceiveChatwootWebhook\(/);
    expect(appSrc).toMatch(/new ListConversations\(/);
    expect(appSrc).toMatch(/new GetConversation\(/);
    expect(appSrc).toMatch(/new ListChatMessages\(/);
    expect(appSrc).toMatch(/new SendMessage\(/);
    expect(appSrc).toMatch(/new GetClientContextByPhone\(/);
  });

  it('(h2) el import de ListMessages está aliased para no chocar con el ListMessages preexistente', () => {
    expect(appSrc).toMatch(
      /import\s*\{\s*ListMessages as ListChatMessages\s*\}\s*from\s*['"]@application\/use-cases\/messaging\/ListMessages['"]/,
    );
  });

  it('(i) GetClientContextByPhone reusa el customerAdapter existente (sin duplicar el port)', () => {
    expect(appSrc).toMatch(/new GetClientContextByPhone\(customerAdapter\)/);
  });

  // ─── messaging-inbox-v2 (F1.5, B5) — GetInboxClientContext wiring ───────────

  it('(j) GetInboxClientContext importado', () => {
    expect(appSrc).toMatch(
      /import\s*\{\s*GetInboxClientContext\s*\}\s*from\s*['"]@application\/use-cases\/messaging\/GetInboxClientContext['"]/,
    );
  });

  it('(k) GetInboxClientContext instanciado (mismo bloque messaging) y pasado a createMessagingRouter dentro de la MISMA llamada de mount', () => {
    const blockIdx = appSrc.indexOf('// ─── messaging-inbox (F1) — Chatwoot webhook ingest');
    expect(blockIdx).toBeGreaterThan(-1);
    const mountIdx = appSrc.indexOf("app.use('/api/messaging', createMessagingRouter(", blockIdx);
    expect(mountIdx).toBeGreaterThan(blockIdx);
    // Instantiated BEFORE the mount call, same pattern as getClientContextByPhone
    // (built once, then passed by name — not inlined `new` inside the call).
    expect(appSrc.slice(blockIdx, mountIdx)).toMatch(/const getInboxClientContext = new GetInboxClientContext\(/);

    const end = appSrc.indexOf('));', mountIdx);
    expect(end).toBeGreaterThan(mountIdx);
    const window = appSrc.slice(mountIdx, end + '));'.length);
    expect(window).toMatch(/^\s*getInboxClientContext,\s*$/m);
  });

  it("(l) exactamente UN requirePerm('messaging', 'read') cubre la ventana de mount (RICH-5 — sin permisos de otros módulos)", () => {
    const idx = appSrc.indexOf("app.use('/api/messaging', createMessagingRouter(");
    const end = appSrc.indexOf('));', idx);
    const window = appSrc.slice(idx, end + '));'.length);
    const matches = window.match(/requirePerm\('messaging',\s*'read'\)/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('(m) el nuevo PrismaPppoeServiceRepository local del bloque messaging sigue el patrón pppoeRepoForInspect (scope acotado, no reusa el pppoeRepo cerrado)', () => {
    const idx = appSrc.indexOf('// ─── messaging-inbox (F1) — Chatwoot webhook ingest');
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf("app.use('/api/messaging', createMessagingRouter(", idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end);
    expect(window).toMatch(/new PrismaPppoeServiceRepository\(\)/);
  });

  // ─── fix-be #1 [ALTO] — TTL drift: GetInboxClientContext se instanciaba SIN el
  // 12º arg `opts`, así que usaba DEFAULT_BALANCE_STALE_TTL_MINUTES=60 hardcoded
  // en vez de config.gestionReal.balanceStaleTtlMinutes (el mismo TTL que ya usa
  // PrismaCustomerRepository/RefreshClientBalanceIfStale via ese mismo config).
  it('(n) GetInboxClientContext recibe el TTL de balance desde config.gestionReal.balanceStaleTtlMinutes (bug: sin esto usaba el default hardcoded 60)', () => {
    const idx = appSrc.indexOf('const getInboxClientContext = new GetInboxClientContext(');
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf(');', idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end);
    expect(window).toMatch(/ttlMinutes:\s*config\.gestionReal\.balanceStaleTtlMinutes/);
  });

  // ─── messaging-inbox-v2-media (F1.5 fase A, Tanda 1) — recibir media wiring ─────

  it('(o) PrismaChatMessageAttachmentRepository + DownloadChatMessageAttachment + FireAndForgetChatMediaDownloadTrigger + GetChatAttachmentFile instanciados', () => {
    expect(appSrc).toMatch(/new PrismaChatMessageAttachmentRepository\(\)/);
    expect(appSrc).toMatch(/new DownloadChatMessageAttachment\(/);
    expect(appSrc).toMatch(/new FireAndForgetChatMediaDownloadTrigger\(/);
    expect(appSrc).toMatch(/new GetChatAttachmentFile\(/);
  });

  it('(p) DownloadChatMessageAttachment reusa taskPhotoStorage (MISMA instancia MinIO que task-photos, bucket compartido)', () => {
    const idx = appSrc.indexOf('const downloadChatMessageAttachment = new DownloadChatMessageAttachment(');
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf(');', idx);
    const window = appSrc.slice(idx, end);
    expect(window).toMatch(/taskPhotoStorage/);
  });

  it('(q) ReceiveChatwootWebhook/GetConversation/ListChatMessages reciben chatAttachmentRepo (paridad webhook + fetch-on-open + DTO)', () => {
    const idx = appSrc.indexOf("app.use('/api/messaging', createMessagingRouter(");
    const end = appSrc.indexOf('));', idx);
    const window = appSrc.slice(idx, end + '));'.length);
    expect(window).toMatch(/new ReceiveChatwootWebhook\([^)]*chatAttachmentRepo/);
    expect(window).toMatch(/new GetConversation\([^)]*chatAttachmentRepo/);
    expect(window).toMatch(/new ListChatMessages\([^)]*chatAttachmentRepo/);
    expect(window).toMatch(/getChatAttachmentFile,/);
  });

  // ─── inbox-views (Ola 1) — contadores por vista wiring ──────────────────────

  it('(r) GetInboxViewCounts instanciado con el MISMO conversationRepo dentro de la llamada de mount (anti-W6: el count comparte builder de where con el listado)', () => {
    const idx = appSrc.indexOf("app.use('/api/messaging', createMessagingRouter(");
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('));', idx);
    const window = appSrc.slice(idx, end + '));'.length);
    expect(window).toMatch(/new GetInboxViewCounts\(conversationRepo\)/);
  });
});

/**
 * H3 (fix wave, LOW — review adversarial) — a diferencia de TODO el resto de
 * este archivo (assertion ESTÁTICA sobre el TEXTO de app.ts, molde repo-wide:
 * pppoe/gigared/tickets-*-composition.test.ts, todos comentan "Booting
 * createApp() needs a live DB"), este describe BOOTEA `createApp()` DE VERDAD
 * y ejercita las rutas nuevas de `inbox-template-send` con supertest — sin
 * armar un wiring propio (a diferencia de `messaging.routes.test.ts`, cuyo
 * `buildApp()` local inyecta SUS PROPIOS repos in-memory y jamás detectaría un
 * `createMessagingRouter(...)` roto o un arg desalineado en el `app.ts` real).
 *
 * Verificado empíricamente (2026-07-16, probe descartado tras confirmar):
 * `createApp()` NO necesita una Postgres viva para CONSTRUIRSE — los repos
 * Prisma son constructores síncronos sin query eager, y `pg.Pool`/`PrismaClient`
 * conectan LAZY recién en la primera query real. El 401 de `auth` (sin cookie
 * de sesión) resuelve ANTES de tocar la DB, así que alcanza como pin de wiring
 * real sin requerir infraestructura extra en CI/worktree.
 *
 * Molde de env-var-injection: `config.messagingBulk.test.ts` (REQUIRED_VARS
 * siempre presentes + `jest.resetModules()` para reimportar `app.ts` en
 * aislamiento — `config.ts` corre `validateEnv()` como side-effect de import y
 * llama `process.exit(1)` si falta alguna, así que las env vars se setean
 * ANTES del `require` dinámico, nunca via `import` estático de nivel de archivo).
 */
describe('Messaging composition root — boot REAL de createApp() (H3, fix wave)', () => {
  const ORIGINAL_ENV = process.env;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prismaModule: any;

  beforeAll(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      SPLYNX_API_URL: 'http://x',
      SPLYNX_API_KEY: 'k',
      SPLYNX_API_SECRET: 's',
      JWT_SECRET: 'j',
      PORT: '3000',
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const appModule = require('../../infrastructure/http/app');
    app = appModule.createApp();
    // Mismo registro de módulos "reseteado" que app.ts acaba de usar internamente
    // (jest.resetModules() de arriba) — este require devuelve el MISMO singleton
    // `prisma` que createApp() cableó, para poder desconectarlo en el afterAll.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    prismaModule = require('../../infrastructure/database/prisma');
  });

  // Residual conocido (verificado en node_modules/@prisma/adapter-pg): `$disconnect()`
  // SÍ libera el estado del query engine, pero NO cierra el `pg.Pool` subyacente —
  // `PrismaPg.dispose()` solo llama `pool.end()` si se construyó con
  // `{disposeExternalPool: true}`, y `database/prisma.ts` (producción, correctamente:
  // un server long-lived NO debe auto-cerrar su pool) no pasa esa opción. Esto puede
  // dejar el timer de idle-connection del pool vivo el tiempo suficiente para que
  // Jest, en ALGUNAS corridas (no todas — depende del scheduling), imprima "A worker
  // process has failed to exit gracefully" al terminar este archivo. Es benigno:
  // no falla ningún test, exit code sigue 0, y el proceso worker de Jest termina de
  // todos modos al cerrar el archivo (el socket se libera a nivel OS). Cambiar
  // `database/prisma.ts` para pasar `disposeExternalPool` está fuera de alcance de
  // este fix wave (afectaría el ciclo de vida del singleton en producción).
  afterAll(async () => {
    process.env = ORIGINAL_ENV;
    await prismaModule?.prisma?.$disconnect?.();
  });

  it('POST /api/messaging/conversations/:id/send-template existe y está detrás de auth REAL (401 sin cookie de sesión, NO 404)', async () => {
    const res = await request(app)
      .post('/api/messaging/conversations/conv-ghost/send-template')
      .send({ templateRef: 'HX1', variables: {} });

    // 401 (no 404) prueba que la ruta está MONTADA en el DI graph real de
    // producción — anti-W6 (feature "wired" en el buildApp del test pero
    // ausente/rota en app.ts pasaría desapercibida sin este boot real).
    expect(res.status).toBe(401);
  }, 20000);

  it('GET /api/messaging/send-templates existe y está detrás de auth REAL (401 sin cookie de sesión, NO 404)', async () => {
    const res = await request(app).get('/api/messaging/send-templates');

    expect(res.status).toBe(401);
  }, 20000);

  it('GET /api/messaging/conversations/counts existe en el DI graph REAL y está detrás de auth (401 sin cookie, NO 404) — inbox-views Ola 1', async () => {
    const res = await request(app).get('/api/messaging/conversations/counts');

    expect(res.status).toBe(401);
  }, 20000);

  it('control — una ruta que de verdad NO existe sigue dando 404 (el 401 de arriba no es un catch-all ciego)', async () => {
    const res = await request(app).post(
      '/api/messaging/conversations/conv-ghost/this-route-does-not-exist',
    );

    expect(res.status).toBe(404);
  }, 20000);
});
