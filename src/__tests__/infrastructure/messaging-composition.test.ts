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
});
