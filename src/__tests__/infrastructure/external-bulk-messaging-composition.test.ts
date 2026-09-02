/**
 * external-bulk-messaging (task 4.5/4.10, COMP-1, D7) — composition-root test,
 * molde `externalV1-ticket-wiring-composition.test.ts` / `assistant-composition.test.ts`.
 *
 * DEVIATION documentada (no un hueco): tasks.md 4.5 pide "bootea createApp()
 * real". Ningún test de este repo hace eso — `assistant-composition.test.ts`
 * explica por qué (importar `app.ts` levanta media aplicación: Prisma,
 * schedulers, adapters HTTP; el test dejaría de ser barato y determinístico).
 * Confirmado acá también: `rg` sobre `src/__tests__` no encuentra NINGÚN test
 * que importe `app.ts`. Se sigue el patrón REAL del repo:
 *   (a) assertions ESTÁTICAS sobre el FUENTE de `app.ts` (índice de mount +
 *       la dependencia `config.externalMessaging.apiKey` pineada, no solo el
 *       nombre del mount) — esto es lo único que puede cazar el bug real
 *       (orden invertido en un merge futuro).
 *   (b) un test de MECÁNICA DE ORDEN: reconstruye el MISMO orden relativo de
 *       mounts (`/messaging/bulk` ANTES del `/api/external/v1` global) con el
 *       middleware REAL (`createApiKeyMiddleware`) + el router REAL
 *       (`createExternalMessagingRouter`) + un stub mínimo para
 *       `/api/external/v1` (su única propiedad relevante acá es "tiene su
 *       propia key" — no hace falta el router real de tickets/news para
 *       probar la mecánica de precedencia de Express). Prueba el MISMO
 *       mecanismo (Express matchea por orden de registro) sin requerir DB.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import express from 'express';
import { createExternalMessagingRouter, ExternalMessagingRouterDeps } from '@infrastructure/http/routes/external-messaging.routes';
import { createApiKeyMiddleware } from '@infrastructure/http/middleware/apiKeyMiddleware';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { ValidateExternalBulk } from '@application/use-cases/messaging/ValidateExternalBulk';
import { SendExternalBulk } from '@application/use-cases/messaging/SendExternalBulk';
import { GetExternalBulkCampaign } from '@application/use-cases/messaging/GetExternalBulkCampaign';
import { ListTemplates } from '@application/use-cases/messaging/ListTemplates';
import { GetTemplate } from '@application/use-cases/messaging/GetTemplate';
import { CreateTemplate } from '@application/use-cases/messaging/CreateTemplate';
import { SubmitTemplateForApproval } from '@application/use-cases/messaging/SubmitTemplateForApproval';
import { CreateCampaign } from '@application/use-cases/messaging/CreateCampaign';
import { InMemoryExternalBulkPreviewRepository } from '@infrastructure/adapters/in-memory/InMemoryExternalBulkPreviewRepository';
import { InMemoryExternalBulkMessagingConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryExternalBulkMessagingConfigRepository';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import { InMemoryTemplateMessagingGateway } from '@infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { bootstrapApiMessagingUser } from '@infrastructure/bootstrap/bootstrapApiMessagingUser';
import { FakeChatwootGateway } from '../helpers/FakeChatwootGateway';
import type { CampaignSegmentSource, CampaignSegmentFilter } from '@domain/ports/CustomerRepository';
import type { TemplateDto } from '@domain/ports/TemplateMessagingPort';
import type { CampaignStarter } from '@domain/ports/CampaignStarter';

jest.mock('@infrastructure/config', () => ({
  config: {
    externalApi: { apiKey: 'unused-global-key' },
    externalMessaging: { apiKey: 'unused-mock-value' },
  },
}));

// ─── (a) Assertions ESTÁTICAS sobre el FUENTE de app.ts ────────────────────

describe('external-bulk-messaging composition root — assertions estáticas (COMP-1)', () => {
  let appSrc: string;
  /**
   * fix wave F1 (R3 #5) — la ventana del mount se recorta con un MARCADOR
   * ÚNICO (`[external-bulk-mount-end]`, presente en `app.ts`) en vez del
   * `indexOf(');')` anterior, que cortaba dentro del primer
   * `new ValidateExternalBulk(...)`: la ventana quedaba truncada a ~3 líneas y
   * TODO `expect(window).not.toMatch(...)` pasaba por vacuidad (un guard que
   * no puede fallar). El propio marcador se assertea, así que borrarlo rompe
   * el test en vez de degradarlo en silencio.
   */
  // Anclado al mount del ROUTER, no al parser path-scoped del mismo prefijo
  // (fix wave F1) — ambos empiezan con la misma llamada `app.use(<prefijo>,`.
  const MOUNT_START = "app.use('/api/external/v1/messaging/bulk',";
  const MOUNT_END = '[external-bulk-mount-end]';
  let mountWindow: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
    // `lastIndexOf`: el prefijo aparece DOS veces (el parser path-scoped del
    // bloque de parsers y, mas abajo, el mount del router). El del router es el
    // ULTIMO — y se verifica abajo que la ventana arranca con `createApiKeyMiddleware`.
    const start = appSrc.lastIndexOf(MOUNT_START);
    const end = appSrc.indexOf(MOUNT_END, start);
    const raw = start > -1 && end > start ? appSrc.slice(start, end) : '';
    // Solo lineas EFECTIVAS: los comentarios de este mismo bloque nombran
    // `express.json(` y `new CreateCampaign(` al explicar por que ya NO estan
    // (regla del repo: "tests sobre texto filtran comentarios").
    mountWindow = raw
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
  });

  it('el marcador de fin del mount existe y la ventana recortada es SUSTANCIAL (guard anti-vacuidad)', () => {
    expect(appSrc).toContain(MOUNT_END);
    expect(mountWindow.length).toBeGreaterThan(500);
    // La ventana llega HASTA el final del bloque: contiene la última dep inyectada.
    expect(mountWindow).toMatch(/featureFlags:/);
    // …y arranca en el mount del ROUTER, no en el parser path-scoped homonimo.
    expect(mountWindow).toMatch(/createApiKeyMiddleware\(config\.externalMessaging\.apiKey\)/);
  });

  /**
   * fix wave F1 (finding F1) — el parser de 2mb path-scoped DEBE registrarse
   * ANTES del `app.use(express.json())` global. Registrado después (como
   * estaba, dentro del propio mount) body-parser lo saltea por `req._body` y
   * el límite de 100kb del global 413ea un lote realista antes del auth.
   */
  it('CRÍTICO (F1) — el parser 2mb de /api/external/v1/messaging/bulk se registra ANTES del express.json() global', () => {
    const scopedIdx = appSrc.indexOf("app.use('/api/external/v1/messaging/bulk', express.json({ limit: '2mb' }))");
    const globalIdx = appSrc.indexOf('app.use(express.json());');

    expect(scopedIdx).toBeGreaterThan(-1);
    expect(globalIdx).toBeGreaterThan(-1);
    expect(scopedIdx).toBeLessThan(globalIdx);
  });

  it('F1 — el mount ya NO declara un express.json propio (era código muerto)', () => {
    expect(mountWindow).not.toMatch(/express\.json\(/);
  });

  it('F7 — el rate limiter de escritura entra por `writeRateLimiter` (dep del router), no como middleware del prefijo', () => {
    expect(mountWindow).toMatch(/writeRateLimiter:\s*createExternalWriteRateLimiter\(\)/);
  });

  it('F6 — el mount adjunta el actor máquina api-messaging para la auditoría', () => {
    expect(mountWindow).toMatch(/machineActorMiddleware\(rbacUserRepo,\s*API_MESSAGING_USER_LOGIN\)/);
  });

  it('F9 — el camino externo comparte la MISMA instancia de CreateCampaign que el router admin', () => {
    expect(mountWindow).toMatch(/bulkCreateCampaign,/);
    expect(mountWindow).not.toMatch(/new CreateCampaign\(/);
    // …y esa instancia se construye con las 7 dependencias del bloque admin.
    expect(appSrc).toMatch(
      /const bulkCreateCampaign = new CreateCampaign\(campaignRepo, customerAdapter, templatePort, customerAdapter, taskRecipientSource, taskStageConfigRepo, taskStageTransitionConfigRepoForBulk\)/,
    );
  });

  it('createExternalMessagingRouter está importado', () => {
    expect(appSrc).toMatch(
      /import\s*\{\s*createExternalMessagingRouter\s*\}\s*from\s*['"]\.\/routes\/external-messaging\.routes['"]/,
    );
  });

  it('createExternalBulkMessagingConfigRouter está importado', () => {
    expect(appSrc).toMatch(
      /import\s*\{\s*createExternalBulkMessagingConfigRouter\s*\}\s*from\s*['"]\.\/routes\/externalBulkMessagingConfig\.routes['"]/,
    );
  });

  it('CRÍTICO — el mount de /api/external/v1/messaging/bulk queda ANTES (índice MENOR) que el mount global /api/external/v1', () => {
    const messagingBulkIdx = appSrc.indexOf(MOUNT_START);
    const globalExternalIdx = appSrc.indexOf("app.use('/api/external/v1',");

    expect(messagingBulkIdx).toBeGreaterThan(-1);
    expect(globalExternalIdx).toBeGreaterThan(-1);
    expect(messagingBulkIdx).toBeLessThan(globalExternalIdx);
  });

  it('el mount de /messaging/bulk usa config.externalMessaging.apiKey — pin de la DEPENDENCIA, no solo el nombre del mount', () => {
    const window = mountWindow;

    expect(window).toMatch(/createApiKeyMiddleware\(config\.externalMessaging\.apiKey\)/);
    expect(window).toMatch(/createExternalMessagingRouter\(/);
    expect(window).toMatch(/validateExternalBulk:/);
    expect(window).toMatch(/sendExternalBulk:/);
    expect(window).toMatch(/getExternalBulkCampaign:/);
  });

  it('B4b — el mount de /messaging/bulk también pasa listTemplates/getTemplate/createTemplate/submitTemplate + featureFlags', () => {
    const window = mountWindow;

    expect(window).toMatch(/listTemplates:/);
    expect(window).toMatch(/getTemplate:/);
    expect(window).toMatch(/createTemplate:/);
    expect(window).toMatch(/submitTemplate:/);
    expect(window).toMatch(/featureFlags:/);
    // D4.f — `deleteTemplate` NUNCA se inyecta al router externo.
    expect(window).not.toMatch(/deleteTemplate:/);
  });

  it('el router de config admin está montado en /api/messaging/config/external-bulk, DESPUÉS de /api/messaging/config/task-stages (D7.c)', () => {
    const taskStagesIdx = appSrc.indexOf("app.use('/api/messaging/config/task-stages'");
    const externalBulkConfigIdx = appSrc.indexOf("app.use('/api/messaging/config/external-bulk'");

    expect(taskStagesIdx).toBeGreaterThan(-1);
    expect(externalBulkConfigIdx).toBeGreaterThan(-1);
    expect(taskStagesIdx).toBeLessThan(externalBulkConfigIdx);
  });
});

// ─── (b) Mecánica de orden — MISMO mecanismo de Express, sin DB ────────────

const NOW = new Date('2026-09-02T12:00:00.000Z');
const FLAG_KEY = 'messaging-external-bulk-enabled';
const DEDICATED_KEY = 'dedicated-key-comp-test';
const GLOBAL_KEY = 'global-key-comp-test';

const TEMPLATE: TemplateDto = {
  contentSid: 'HXpromo1',
  friendlyName: 'promo_setiembre',
  language: 'es',
  variables: {},
  approvalStatus: 'approved',
  body: 'Hola',
};

function makeSegmentSource(): CampaignSegmentSource {
  return { listSegmentRecipients: async (_s: CampaignSegmentFilter) => [] };
}

class FakeCampaignStarter implements CampaignStarter {
  async start(_campaignId: string): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
}

/**
 * Reconstruye el orden REAL de `app.ts`: el router de `/messaging/bulk` (key
 * dedicada) se registra ANTES del stub de `/api/external/v1` (key global) —
 * exactamente el orden que COMP-1 exige. El stub NO necesita ser
 * `createExternalV1Router` real: lo único que importa acá es que está
 * detrás de SU PROPIA key, para probar que Express matchea el prefijo MÁS
 * ESPECÍFICO registrado primero, no el que "parece" más específico en el path.
 */
function buildOrderedApp(opts: { dedicatedKey?: string; flagEnabled?: boolean } = {}) {
  const previewRepo = new InMemoryExternalBulkPreviewRepository({ now: () => NOW });
  const configRepo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
  const campaignRepo = new InMemoryCampaignRepository({ now: () => NOW });
  const templatePort = new InMemoryTemplateMessagingGateway({ templates: [TEMPLATE] });
  const chatwootGateway = new FakeChatwootGateway();
  const featureFlags = new InMemoryFeatureFlagRepository();
  if (opts.flagEnabled !== false) featureFlags.seed(FLAG_KEY, true);
  const rbacUserRepo = new InMemoryRbacUserRepository();
  const segmentSource = makeSegmentSource();
  const createCampaign = new CreateCampaign(campaignRepo, segmentSource, templatePort);

  const deps: ExternalMessagingRouterDeps = {
    validateExternalBulk: new ValidateExternalBulk(
      previewRepo, configRepo, campaignRepo, templatePort, segmentSource,
      chatwootGateway, featureFlags, rbacUserRepo, () => NOW,
    ),
    sendExternalBulk: new SendExternalBulk(
      previewRepo, configRepo, campaignRepo, templatePort, chatwootGateway,
      featureFlags, rbacUserRepo, createCampaign, new FakeCampaignStarter(), () => NOW,
    ),
    getExternalBulkCampaign: new GetExternalBulkCampaign(campaignRepo, rbacUserRepo),
    listTemplates: new ListTemplates(templatePort),
    getTemplate: new GetTemplate(templatePort),
    createTemplate: new CreateTemplate(templatePort),
    submitTemplate: new SubmitTemplateForApproval(templatePort),
    featureFlags,
  };

  const app = express();
  app.use(express.json());

  const dedicatedKey = opts.dedicatedKey ?? DEDICATED_KEY;
  // MISMO orden relativo que app.ts: /messaging/bulk PRIMERO.
  app.use('/api/external/v1/messaging/bulk', createApiKeyMiddleware(dedicatedKey), createExternalMessagingRouter(deps));
  // Stub del mount global — SOLO necesita responder algo bajo SU propia key,
  // para distinguir "la key global abrió esto" de "401 en todos lados".
  app.use('/api/external/v1', createApiKeyMiddleware(GLOBAL_KEY), (_req, res) => {
    res.status(200).json({ stub: 'external-v1' });
  });
  app.use(errorHandler);

  return { app, campaignRepo, rbacUserRepo };
}

describe('external-bulk-messaging composition root — mecánica de orden (AUTH-2/AUTH-3)', () => {
  it('key GLOBAL → 401 en /messaging/bulk/validate (la key global NO abre el router dedicado)', async () => {
    const { app } = buildOrderedApp();
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', GLOBAL_KEY)
      .send({ templateRef: TEMPLATE.contentSid, recipients: [{ phone: '011 15-2345-6789' }] });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('key DEDICADA → pasa el auth (nunca 401) — 200/4xx de negocio', async () => {
    const { app } = buildOrderedApp();
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ templateRef: TEMPLATE.contentSid, recipients: [{ phone: '011 15-2345-6789' }] });
    expect(res.status).not.toBe(401);
  });

  it('B4b — key GLOBAL → 401 en GET /messaging/bulk/templates (el orden de mounts también protege las rutas nuevas)', async () => {
    const { app } = buildOrderedApp();
    const res = await request(app)
      .get('/api/external/v1/messaging/bulk/templates')
      .set('X-Api-Key', GLOBAL_KEY);
    expect(res.status).toBe(401);
  });

  it('key dedicada VACÍA en el proceso → 401 con CUALQUIER key, incluso vacía (AUTH-3, fail-closed)', async () => {
    const { app } = buildOrderedApp({ dedicatedKey: '' });

    const withGlobal = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', GLOBAL_KEY)
      .send({ templateRef: TEMPLATE.contentSid, recipients: [] });
    expect(withGlobal.status).toBe(401);

    const withEmpty = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', '')
      .send({ templateRef: TEMPLATE.contentSid, recipients: [] });
    expect(withEmpty.status).toBe(401);

    const withNoHeader = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .send({ templateRef: TEMPLATE.contentSid, recipients: [] });
    expect(withNoHeader.status).toBe(401);
  });

  it('flag OFF → 403 FEATURE_DISABLED en validate/send/templates (con la key dedicada correcta)', async () => {
    const { app } = buildOrderedApp({ flagEnabled: false });

    const validate = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ templateRef: TEMPLATE.contentSid, recipients: [{ phone: '011 15-2345-6789' }] });
    expect(validate.status).toBe(403);
    expect(validate.body.code).toBe('FEATURE_DISABLED');

    const send = await request(app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .set('Idempotency-Key', 'key-1')
      .send({ previewId: 'whatever' });
    expect(send.status).toBe(403);
    expect(send.body.code).toBe('FEATURE_DISABLED');

    const templates = await request(app)
      .get('/api/external/v1/messaging/bulk/templates')
      .set('X-Api-Key', DEDICATED_KEY);
    expect(templates.status).toBe(403);
    expect(templates.body.code).toBe('FEATURE_DISABLED');

    const getTemplate = await request(app)
      .get(`/api/external/v1/messaging/bulk/templates/${TEMPLATE.contentSid}`)
      .set('X-Api-Key', DEDICATED_KEY);
    expect(getTemplate.status).toBe(403);

    const createTemplate = await request(app)
      .post('/api/external/v1/messaging/bulk/templates')
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ friendlyName: 'x', language: 'es', body: 'y' });
    expect(createTemplate.status).toBe(403);

    const submitTemplate = await request(app)
      .post(`/api/external/v1/messaging/bulk/templates/${TEMPLATE.contentSid}/submit`)
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ name: 'x', category: 'MARKETING' });
    expect(submitTemplate.status).toBe(403);
  });

  it('STATUS-1 — flag OFF/missing: el kill-switch OFF no gatea el GET de estado (D12/D14)', async () => {
    const { app, campaignRepo, rbacUserRepo } = buildOrderedApp({ flagEnabled: false });
    const apiUser = await bootstrapApiMessagingUser(rbacUserRepo, { passwordHash: 'unusable-hash' });
    const campaign = await campaignRepo.create({
      name: 'external-campaign',
      templateRef: TEMPLATE.contentSid,
      templateName: TEMPLATE.friendlyName,
      createdById: apiUser.id,
      variableSpec: {},
      segment: { statuses: [] },
      total: 0,
    });

    // Control — mismo harness, `/validate` SIGUE 403 con el flag OFF (D14: el
    // kill-switch gatea validate/send/templates, NUNCA el polling de estado).
    const validate = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ templateRef: TEMPLATE.contentSid, recipients: [{ phone: '011 15-2345-6789' }] });
    expect(validate.status).toBe(403);
    expect(validate.body.code).toBe('FEATURE_DISABLED');

    const status = await request(app)
      .get(`/api/external/v1/messaging/bulk/campaigns/${campaign.id}`)
      .set('X-Api-Key', DEDICATED_KEY);
    expect(status.status).toBe(200);
    expect(status.body.campaignId).toBe(campaign.id);
  });
});

// ─── (c) MECANICA del body parser (fix wave F1, finding F1) ────────────────

/**
 * El bug real era de ORDEN DE REGISTRO, no de configuracion: body-parser
 * marca `req._body` tras parsear, y todo parser posterior se convierte en un
 * no-op. Un `express.json({limit:'2mb'})` registrado DENTRO del mount (o sea,
 * despues del `app.use(express.json())` global de 100kb) nunca corre: el
 * global ya 413eo el request. Estos dos tests prueban el MISMO mecanismo de
 * Express con los DOS ordenes, sin depender de `app.ts`.
 */
describe('external-bulk-messaging — mecanica del body parser 2mb (fix wave F1, F1)', () => {
  const BIG_BODY = { recipients: Array.from({ length: 12000 }, (_, i) => ({ phone: `+54911234${String(i).padStart(5, '0')}` })) };

  function buildParserApp(order: 'scoped-first' | 'global-first') {
    const app = express();
    if (order === 'scoped-first') {
      app.use('/api/external/v1/messaging/bulk', express.json({ limit: '2mb' }));
      app.use(express.json());
    } else {
      app.use(express.json());
      app.use('/api/external/v1/messaging/bulk', express.json({ limit: '2mb' }));
    }
    app.post('/api/external/v1/messaging/bulk/validate', (req, res) => {
      res.status(200).json({ received: (req.body as { recipients: unknown[] }).recipients.length });
    });
    app.post('/api/other', (_req, res) => res.status(200).json({ ok: true }));
    return app;
  }

  it('el body grande (~300 KB) pasa por la ruta scoped cuando el parser 2mb se registra ANTES del global — el orden del fix', async () => {
    expect(JSON.stringify(BIG_BODY).length).toBeGreaterThan(100 * 1024);

    const res = await request(buildParserApp('scoped-first'))
      .post('/api/external/v1/messaging/bulk/validate')
      .send(BIG_BODY);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(12000);
  });

  it('el MISMO body a otra ruta sigue 413 — el override es path-scoped, no un limite global nuevo', async () => {
    const res = await request(buildParserApp('scoped-first')).post('/api/other').send(BIG_BODY);

    expect(res.status).toBe(413);
  });

  it('CONTRAFACTICO — con el orden VIEJO (scoped despues del global) el mismo body muere con 413', async () => {
    const res = await request(buildParserApp('global-first'))
      .post('/api/external/v1/messaging/bulk/validate')
      .send(BIG_BODY);

    expect(res.status).toBe(413);
  });
});
