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
});
