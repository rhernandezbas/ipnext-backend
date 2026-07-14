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

  it('(e) SendCampaign reusa customerAdapter (sin duplicar el port) + CampaignRunner con new PgAdvisoryLock()', () => {
    const idx = appSrc.indexOf('// ─── messaging-bulk (F2)');
    const end = appSrc.indexOf("app.use('/api/messaging/bulk', createMessagingBulkRouter(", idx);
    const window = appSrc.slice(idx, end);
    expect(window).toMatch(/new SendCampaign\(campaignRepo,\s*customerAdapter,\s*templatePort,\s*rateLimiter\)/);
    expect(window).toMatch(/new CampaignRunner\(sendCampaign,\s*campaignRepo,\s*new PgAdvisoryLock\(\)\)/);
  });

  it('(f) las 6 dependencias wired dentro de la MISMA llamada de mount', () => {
    const idx = appSrc.indexOf("app.use('/api/messaging/bulk', createMessagingBulkRouter(");
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('));', idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end + '));'.length);

    expect(window).toMatch(/new ListMessagingTemplates\(templatePort\)/);
    expect(window).toMatch(/new PreviewCampaignSegment\(customerAdapter\)/);
    expect(window).toMatch(/new CreateCampaign\(campaignRepo,\s*customerAdapter,\s*templatePort\)/);
    expect(window).toMatch(/^\s*campaignRunner,\s*$/m);
    expect(window).toMatch(/new GetCampaign\(campaignRepo\)/);
    expect(window).toMatch(/new ListCampaigns\(campaignRepo\)/);
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
    expect(window).toMatch(/new ReceiveChatwootWebhook\([^)]*,\s*customerAdapter\)/);
  });

  it('(j) PrismaCampaignRepository importado desde el adapter correcto', () => {
    expect(appSrc).toMatch(/import\s*\{\s*PrismaCampaignRepository\s*\}\s*from\s*['"]\.\.\/adapters\/prisma\/PrismaCampaignRepository['"]/);
  });
});
