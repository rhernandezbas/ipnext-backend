/**
 * external-bulk-messaging (task 4.2/4.3, D7.a, D11) — supertest sobre
 * `createExternalMessagingRouter` con use cases REALES + adapters in-memory
 * (JAMÁS se mockea el use case ni Prisma, lección #28/#27 — un use case
 * mockeado esconde bugs de passthrough). Matriz: un test por `code` del mapeo
 * D7.a + auth aislada a nivel router (AUTH-1/2 sin el orden real de mounts,
 * eso lo pinea 4.5) + AUDIT-1 (validate rechazado también audita).
 */
import request from 'supertest';
import express from 'express';
import { createExternalMessagingRouter, ExternalMessagingRouterDeps } from '@infrastructure/http/routes/external-messaging.routes';
import { createApiKeyMiddleware } from '@infrastructure/http/middleware/apiKeyMiddleware';
import { auditMutationsMiddleware } from '@infrastructure/http/middleware/auditMutationsMiddleware';
import { machineActorMiddleware } from '@infrastructure/http/middleware/machineActorMiddleware';
import { createExternalWriteRateLimiter } from '@infrastructure/http/middleware/rateLimiters';
import { API_MESSAGING_USER_LOGIN } from '@domain/constants/machineUsers';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { ValidateExternalBulk } from '@application/use-cases/messaging/ValidateExternalBulk';
import { SendExternalBulk } from '@application/use-cases/messaging/SendExternalBulk';
import { GetExternalBulkCampaign } from '@application/use-cases/messaging/GetExternalBulkCampaign';
import { ListTemplates } from '@application/use-cases/messaging/ListTemplates';
import { GetTemplate } from '@application/use-cases/messaging/GetTemplate';
import { CreateTemplate } from '@application/use-cases/messaging/CreateTemplate';
import { SubmitTemplateForApproval } from '@application/use-cases/messaging/SubmitTemplateForApproval';
import { CreateCampaign } from '@application/use-cases/messaging/CreateCampaign';
import { externalBulkPayloadHash } from '@application/use-cases/messaging/externalBulkPayloadHash';
import { InMemoryExternalBulkPreviewRepository } from '@infrastructure/adapters/in-memory/InMemoryExternalBulkPreviewRepository';
import { InMemoryExternalBulkMessagingConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryExternalBulkMessagingConfigRepository';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import { InMemoryTemplateMessagingGateway } from '@infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryAuditEventRepository } from '@infrastructure/adapters/in-memory/InMemoryAuditEventRepository';
import { bootstrapApiMessagingUser } from '@infrastructure/bootstrap/bootstrapApiMessagingUser';
import { FakeChatwootGateway } from '../helpers/FakeChatwootGateway';
import type { CampaignSegmentSource, CampaignRecipientCandidate, CampaignSegmentFilter } from '@domain/ports/CustomerRepository';
import type { TemplateDto } from '@domain/ports/TemplateMessagingPort';
import type { CampaignStarter } from '@domain/ports/CampaignStarter';
import type { ExternalBulkPreviewCreateData } from '@domain/ports/ExternalBulkPreviewRepository';

// `apiKeyMiddleware.ts` imports `config`, which fail-fasts at import time if
// REQUIRED_VARS aren't set in the process env (molde `externalV1.routes.test.ts`).
// This router test passes the dedicated key EXPLICITLY to `createApiKeyMiddleware`,
// so the mocked value here is irrelevant — it only exists to dodge the env crash.
jest.mock('@infrastructure/config', () => ({
  config: {
    externalApi: { apiKey: 'unused-global-key' },
    externalMessaging: { apiKey: 'unused-mock-value' },
  },
}));

const NOW = new Date('2026-09-02T12:00:00.000Z');
const FLAG_KEY = 'messaging-external-bulk-enabled';
const DEDICATED_KEY = 'dedicated-external-messaging-key';

const TEMPLATE: TemplateDto = {
  contentSid: 'HXpromo1',
  friendlyName: 'promo_setiembre',
  language: 'es',
  variables: { '1': 'Nombre' },
  approvalStatus: 'approved',
  body: 'Hola {{1}}',
};

function makeSegmentSource(universe: CampaignRecipientCandidate[] = []): CampaignSegmentSource {
  return { listSegmentRecipients: async (_s: CampaignSegmentFilter) => universe };
}

class FakeCampaignStarter implements CampaignStarter {
  public accepted = true;
  async start(_campaignId: string): Promise<{ accepted: boolean }> {
    return { accepted: this.accepted };
  }
}

interface BuildAppOpts {
  templates?: TemplateDto[];
  flagEnabled?: boolean;
  bootstrapApiMessaging?: boolean;
  chatwootLabels?: string[];
  chatwootThrows?: boolean;
  runnerAccepted?: boolean;
  withAudit?: boolean;
  configPatch?: { maxPerRequest: number; maxPerDay: number };
  writeRateLimiter?: import('express').RequestHandler;
}

function buildApp(opts: BuildAppOpts = {}) {
  const previewRepo = new InMemoryExternalBulkPreviewRepository({ now: () => NOW });
  const configRepo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
  const campaignRepo = new InMemoryCampaignRepository({ now: () => NOW });
  const templatePort = new InMemoryTemplateMessagingGateway({ templates: opts.templates ?? [TEMPLATE] });
  const chatwootGateway = new FakeChatwootGateway();
  chatwootGateway.accountLabelsResult = (opts.chatwootLabels ?? []).map((title) => ({ title, color: 'blue' }));
  if (opts.chatwootThrows) chatwootGateway.failListAccountLabels = true;
  const featureFlags = new InMemoryFeatureFlagRepository();
  if (opts.flagEnabled !== false) featureFlags.seed(FLAG_KEY, true);
  const rbacUserRepo = new InMemoryRbacUserRepository();

  const segmentSource = makeSegmentSource();
  const createCampaign = new CreateCampaign(campaignRepo, segmentSource, templatePort);
  const campaignStarter = new FakeCampaignStarter();
  campaignStarter.accepted = opts.runnerAccepted !== false;

  const validateExternalBulk = new ValidateExternalBulk(
    previewRepo, configRepo, campaignRepo, templatePort, segmentSource,
    chatwootGateway, featureFlags, rbacUserRepo, () => NOW,
  );
  const sendExternalBulk = new SendExternalBulk(
    previewRepo, configRepo, campaignRepo, templatePort, chatwootGateway,
    featureFlags, rbacUserRepo, createCampaign, campaignStarter, () => NOW,
  );
  const getExternalBulkCampaign = new GetExternalBulkCampaign(campaignRepo, rbacUserRepo);

  const deps: ExternalMessagingRouterDeps = {
    validateExternalBulk,
    sendExternalBulk,
    getExternalBulkCampaign,
    listTemplates: new ListTemplates(templatePort),
    getTemplate: new GetTemplate(templatePort),
    createTemplate: new CreateTemplate(templatePort),
    submitTemplate: new SubmitTemplateForApproval(templatePort),
    featureFlags,
    // fix wave F1 (F7) — el limiter de ESCRITURA entra como dep del router y
    // solo cubre los POST; los GET (status/templates) quedan libres.
    ...(opts.writeRateLimiter ? { writeRateLimiter: opts.writeRateLimiter } : {}),
  };

  const app = express();
  app.use(express.json());
  const auditRepo = new InMemoryAuditEventRepository();
  if (opts.withAudit) app.use(auditMutationsMiddleware(auditRepo));
  // MISMO orden que `app.ts` (fix wave F1, F6): la key dedicada, despues el
  // actor MAQUINA, despues el router. `auditMutationsMiddleware` (arriba) lee
  // `req.user` recien en `res.on('finish')`.
  app.use(
    '/api/external/v1/messaging/bulk',
    createApiKeyMiddleware(DEDICATED_KEY),
    machineActorMiddleware(rbacUserRepo, API_MESSAGING_USER_LOGIN),
    createExternalMessagingRouter(deps),
  );
  app.use(errorHandler);

  return { app, previewRepo, configRepo, campaignRepo, rbacUserRepo, templatePort, auditRepo };
}

async function seedApiMessagingUser(rbacUserRepo: InMemoryRbacUserRepository): Promise<string> {
  const bootstrap = await bootstrapApiMessagingUser(rbacUserRepo, { passwordHash: 'unusable-hash' });
  return bootstrap.id;
}

function buildPreviewData(opts: {
  recipients: { phoneE164: string; name: string; variables: Record<string, string> }[];
  chatwootLabel?: string | null;
  expiresAt?: string;
  wrongHash?: boolean;
}): ExternalBulkPreviewCreateData {
  const templateName = TEMPLATE.friendlyName;
  const variables = {};
  const chatwootLabel = opts.chatwootLabel ?? null;
  const recipients = opts.recipients.map((r) => ({
    phoneE164: r.phoneE164,
    phoneNormalized: r.phoneE164,
    name: r.name,
    variables: r.variables,
  }));
  const payloadHash = opts.wrongHash
    ? 'deadbeef-wrong-hash'
    : externalBulkPayloadHash({
        templateName,
        variables,
        chatwootLabel,
        recipients: recipients.map((r) => ({ phone: r.phoneE164, name: r.name, variables: r.variables })),
      });
  return {
    payloadHash,
    templateRef: TEMPLATE.contentSid,
    templateName,
    variables,
    chatwootLabel,
    recipients,
    invalid: [],
    validCount: recipients.length,
    invalidCount: 0,
    expiresAt: opts.expiresAt ?? new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
  };
}

const ONE_RECIPIENT = [{ phoneE164: '+5491123456789', name: 'Ana', variables: { '1': 'Ana' } }];

// AR mobile en discado nacional (área 011 + marcador "15" + abonado) — MISMO
// formato que `MOBILE_A` en `ValidateExternalBulk.test.ts` (molde de "número
// móvil válido" reusado acá para no reinventar el reconocimiento de
// `hasArMobileMarker`).
const VALID_BODY = {
  templateRef: TEMPLATE.contentSid,
  // TEMPLATE declara `{"1"}` (body "Hola {{1}}") — sin esto el único recipient
  // cae en `invalid:'variables_faltantes'` y el batch entero → EMPTY_RECIPIENTS.
  variables: { '1': 'Nombre' },
  recipients: [{ phone: '011 15-2345-6789' }],
};

describe('POST /validate', () => {
  it('body basura (recipients no-array) → 400 VALIDATION_ERROR, NO 500 (D11 lección)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ templateRef: TEMPLATE.contentSid, recipients: 'not-an-array' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('JSON con tipos equivocados en un recipient → 400, no 500', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ templateRef: TEMPLATE.contentSid, recipients: [{ phone: 12345 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('FEATURE_DISABLED → 403 cuando el flag está OFF', async () => {
    const { app } = buildApp({ flagEnabled: false });
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', DEDICATED_KEY)
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });

  it('TEMPLATE_NOT_APPROVED → 422 cuando el template no existe/no está aprobado', async () => {
    const { app } = buildApp({ templates: [{ ...TEMPLATE, approvalStatus: 'pending' }] });
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', DEDICATED_KEY)
      .send(VALID_BODY);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TEMPLATE_NOT_APPROVED');
  });

  it('CHATWOOT_LABEL_NOT_FOUND → 422 cuando el label no está en el catálogo vivo', async () => {
    const { app } = buildApp({ chatwootLabels: [] });
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ ...VALID_BODY, chatwootLabel: 'no-existe' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CHATWOOT_LABEL_NOT_FOUND');
  });

  it('CHATWOOT_UNAVAILABLE → 503 cuando Chatwoot lanza al listar labels', async () => {
    const { app } = buildApp({ chatwootThrows: true });
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ ...VALID_BODY, chatwootLabel: 'promo' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('CHATWOOT_UNAVAILABLE');
  });

  it('EMPTY_RECIPIENTS → 422 cuando TODO el batch cae inválido', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ templateRef: TEMPLATE.contentSid, recipients: [{ phone: '123' }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EMPTY_RECIPIENTS');
  });

  it('CAP_EXCEEDED (perRequest) → 422 cuando el batch excede maxPerRequest', async () => {
    const { app, configRepo } = buildApp();
    await configRepo.set({ maxPerRequest: 1, maxPerDay: 2000 });
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', DEDICATED_KEY)
      .send({
        templateRef: TEMPLATE.contentSid,
        variables: { '1': 'Nombre' },
        recipients: [{ phone: '011 15-2345-6789' }, { phone: '011 15-2345-6780' }],
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CAP_EXCEEDED');
  });

  it('200 en el camino feliz — respuesta con la forma D12/VAL-9', async () => {
    const { app, rbacUserRepo } = buildApp();
    await seedApiMessagingUser(rbacUserRepo);
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', DEDICATED_KEY)
      .send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.previewId).toEqual(expect.any(String));
    expect(res.body.valid).toHaveLength(1);
    expect(res.body.counts.valid).toBe(1);
  });
});

describe('POST /send', () => {
  it('FEATURE_DISABLED → 403 cuando el flag está OFF', async () => {
    const { app, previewRepo } = buildApp({ flagEnabled: false });
    const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .set('Idempotency-Key', 'key-1')
      .send({ previewId: preview.id });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });

  it('sin Idempotency-Key → 400 VALIDATION_ERROR (SEND-1)', async () => {
    const { app, previewRepo } = buildApp();
    const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ previewId: preview.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('PREVIEW_NOT_FOUND → 404 cuando el previewId no existe', async () => {
    const { app, rbacUserRepo } = buildApp();
    await seedApiMessagingUser(rbacUserRepo);
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .set('Idempotency-Key', 'key-1')
      .send({ previewId: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PREVIEW_NOT_FOUND');
  });

  it('PREVIEW_EXPIRED → 410 cuando el preview venció', async () => {
    const { app, previewRepo, rbacUserRepo } = buildApp();
    await seedApiMessagingUser(rbacUserRepo);
    const preview = await previewRepo.create(
      buildPreviewData({ recipients: ONE_RECIPIENT, expiresAt: new Date(NOW.getTime() - 1000).toISOString() }),
    );
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .set('Idempotency-Key', 'key-1')
      .send({ previewId: preview.id });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('PREVIEW_EXPIRED');
  });

  it('PREVIEW_PAYLOAD_MISMATCH → 409 cuando el hash re-calculado no matchea', async () => {
    const { app, previewRepo, rbacUserRepo } = buildApp();
    await seedApiMessagingUser(rbacUserRepo);
    const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT, wrongHash: true }));
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .set('Idempotency-Key', 'key-1')
      .send({ previewId: preview.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREVIEW_PAYLOAD_MISMATCH');
  });

  it('PREVIEW_ALREADY_CONSUMED → 409 cuando el preview ya fue consumido por OTRA key', async () => {
    const { app, previewRepo, rbacUserRepo } = buildApp();
    await seedApiMessagingUser(rbacUserRepo);
    const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
    await previewRepo.markConsumed(preview.id, 'some-other-campaign');
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .set('Idempotency-Key', 'brand-new-key')
      .send({ previewId: preview.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREVIEW_ALREADY_CONSUMED');
  });

  it('IDEMPOTENCY_KEY_CONFLICT → 409 cuando la MISMA key se reusa con OTRO previewId', async () => {
    const { app, previewRepo, rbacUserRepo } = buildApp();
    await seedApiMessagingUser(rbacUserRepo);
    const preview1 = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
    const preview2 = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

    const first = await request(app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .set('Idempotency-Key', 'shared-key')
      .send({ previewId: preview1.id });
    expect(first.status).toBe(202);

    const second = await request(app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .set('Idempotency-Key', 'shared-key')
      .send({ previewId: preview2.id });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('CAMPAIGN_RUNNER_BUSY → 409 con header Retry-After + body {campaignId, retryAfterSeconds}', async () => {
    const { app, previewRepo, rbacUserRepo } = buildApp({ runnerAccepted: false });
    await seedApiMessagingUser(rbacUserRepo);
    const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .set('Idempotency-Key', 'key-1')
      .send({ previewId: preview.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CAMPAIGN_RUNNER_BUSY');
    expect(res.body.campaignId).toEqual(expect.any(String));
    expect(res.body.retryAfterSeconds).toBe(60);
    expect(res.headers['retry-after']).toBe('60');
  });

  it('REPORTER_UNAVAILABLE → 503 cuando api-messaging no está bootstrapeado', async () => {
    const { app, previewRepo } = buildApp({ bootstrapApiMessaging: false });
    const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .set('Idempotency-Key', 'key-1')
      .send({ previewId: preview.id });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('REPORTER_UNAVAILABLE');
  });

  it('202 en el camino feliz — {campaignId, accepted:true, total}', async () => {
    const { app, previewRepo, rbacUserRepo } = buildApp();
    await seedApiMessagingUser(rbacUserRepo);
    const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .set('Idempotency-Key', 'key-1')
      .send({ previewId: preview.id });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: true, total: 1 });
    expect(res.body.campaignId).toEqual(expect.any(String));
  });
});

describe('GET /campaigns/:id (STATUS-1)', () => {
  it('propia → 200 con el estado/contadores', async () => {
    const { app, previewRepo, rbacUserRepo } = buildApp();
    await seedApiMessagingUser(rbacUserRepo);
    const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
    const send = await request(app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .set('Idempotency-Key', 'key-1')
      .send({ previewId: preview.id });
    const campaignId = send.body.campaignId as string;

    const res = await request(app)
      .get(`/api/external/v1/messaging/bulk/campaigns/${campaignId}`)
      .set('X-Api-Key', DEDICATED_KEY);
    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBe(campaignId);
    expect(res.body.total).toBe(1);
  });

  it('ajena/inexistente → 404 CAMPAIGN_NOT_FOUND (no revela existencia)', async () => {
    const { app, rbacUserRepo, campaignRepo } = buildApp();
    await seedApiMessagingUser(rbacUserRepo);
    const admin = await campaignRepo.create({
      name: 'admin-campaign',
      templateRef: TEMPLATE.contentSid,
      templateName: TEMPLATE.friendlyName,
      createdById: 'some-admin-user',
      variableSpec: {},
      segment: { statuses: [] },
      total: 0,
    });
    const res = await request(app)
      .get(`/api/external/v1/messaging/bulk/campaigns/${admin.id}`)
      .set('X-Api-Key', DEDICATED_KEY);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CAMPAIGN_NOT_FOUND');
  });
});

describe('Auth aislada a nivel router (AUTH-1/2, el orden real de mounts lo pinea 4.5)', () => {
  it('sin X-Api-Key → 401 en TODAS las rutas del router', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/external/v1/messaging/bulk/validate').send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('key incorrecta → 401', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', 'wrong-key')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('GET /templates sin key → 401', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/external/v1/messaging/bulk/templates');
    expect(res.status).toBe(401);
  });
});

describe('AUDIT-1 — validate y send quedan auditados', () => {
  it('validate rechazado (422 CAP_EXCEEDED) sigue devolviendo 422 sin excepción no controlada en el audit middleware', async () => {
    const { app, configRepo, auditRepo } = buildApp({ withAudit: true });
    await configRepo.set({ maxPerRequest: 1, maxPerDay: 2000 });
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/validate')
      .set('X-Api-Key', DEDICATED_KEY)
      .send({
        templateRef: TEMPLATE.contentSid,
        variables: { '1': 'Nombre' },
        recipients: [{ phone: '011 15-2345-6789' }, { phone: '011 15-2345-6780' }],
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CAP_EXCEEDED');
    await new Promise((resolve) => setImmediate(resolve));
    const page = await auditRepo.list({ page: 1, pageSize: 10 });
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(page.items[0]?.statusCode).toBe(422);
  });

  it('send exitoso queda auditado con el campaignId creado', async () => {
    const { app, previewRepo, rbacUserRepo, auditRepo } = buildApp({ withAudit: true });
    await seedApiMessagingUser(rbacUserRepo);
    const preview = await previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));
    const res = await request(app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .set('Idempotency-Key', 'key-1')
      .send({ previewId: preview.id });
    expect(res.status).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));
    const page = await auditRepo.list({ page: 1, pageSize: 10 });
    expect(page.total).toBeGreaterThanOrEqual(1);
    const sendEvent = page.items.find((e) => e.path.includes('/send'));
    expect(sendEvent?.statusCode).toBe(202);
  });
});

// ─── fix wave F1 (findings F6, F7, F3) ─────────────────────────────────────

/**
 * AUDIT-1 exige un registro que identifique el ORIGEN (`api-messaging`) y el
 * resultado, en exito Y en rechazo. La auditoria generica ya cubria el POST,
 * pero con `actorLogin:'anonymous'`: indistinguible de cualquier otro M2M, no
 * filtrable, no atribuible. `machineActorMiddleware` adjunta el `RbacUser` REAL
 * (el MISMO de `Campaign.createdById`) antes del router.
 */
describe('fix wave F1 (F6) — AUDIT-1: el actor auditado es api-messaging, no anonymous', () => {
  async function auditRowsFor(
    path: string,
    run: (app: express.Express) => Promise<unknown>,
    opts: BuildAppOpts & { caps?: { maxPerRequest: number; maxPerDay: number } } = {},
  ) {
    const built = buildApp({ withAudit: true, ...opts });
    await seedApiMessagingUser(built.rbacUserRepo);
    if (opts.caps) await built.configRepo.set(opts.caps);
    await run(built.app);
    await new Promise((resolve) => setImmediate(resolve));
    const page = await built.auditRepo.list({ page: 1, pageSize: 20 });
    return page.items.filter((e) => e.path.includes(path));
  }

  it('validate 200 → fila de auditoria con actorLogin api-messaging', async () => {
    const rows = await auditRowsFor('/validate', (app) =>
      request(app)
        .post('/api/external/v1/messaging/bulk/validate')
        .set('X-Api-Key', DEDICATED_KEY)
        .send({ templateRef: TEMPLATE.contentSid, recipients: [{ phone: '011 15-2345-6789', variables: { '1': 'Ana' } }] }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorLogin).toBe(API_MESSAGING_USER_LOGIN);
    expect(rows[0]!.actorId).toBeTruthy();
    expect(rows[0]!.statusCode).toBe(200);
  });

  it('validate 422 CAP_EXCEEDED → el RECHAZO tambien queda auditado con el actor real', async () => {
    const rows = await auditRowsFor(
      '/validate',
      (app) =>
        request(app)
          .post('/api/external/v1/messaging/bulk/validate')
          .set('X-Api-Key', DEDICATED_KEY)
          .send({
            templateRef: TEMPLATE.contentSid,
            variables: { '1': 'Ana' },
            recipients: [{ phone: '011 15-2345-6789' }, { phone: '011 15-9876-5432' }],
          }),
      { caps: { maxPerRequest: 1, maxPerDay: 2000 } },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.statusCode).toBe(422);
    expect(rows[0]!.actorLogin).toBe(API_MESSAGING_USER_LOGIN);
  });

  it('send 202 y send 409 (runner ocupado) quedan auditados con el actor real', async () => {
    for (const runnerAccepted of [true, false]) {
      const built = buildApp({ withAudit: true, runnerAccepted });
      await seedApiMessagingUser(built.rbacUserRepo);
      const preview = await built.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

      const res = await request(built.app)
        .post('/api/external/v1/messaging/bulk/send')
        .set('X-Api-Key', DEDICATED_KEY)
        .set('Idempotency-Key', 'key-audit')
        .send({ previewId: preview.id });

      expect(res.status).toBe(runnerAccepted ? 202 : 409);
      await new Promise((resolve) => setImmediate(resolve));
      const page = await built.auditRepo.list({ page: 1, pageSize: 20 });
      const row = page.items.find((e) => e.path.includes('/send'));
      expect(row?.actorLogin).toBe(API_MESSAGING_USER_LOGIN);
      expect(row?.statusCode).toBe(runnerAccepted ? 202 : 409);
    }
  });
});

/**
 * El limiter de escritura (30 req/60s por IP) cubria TODO el prefijo, incluido
 * `GET /campaigns/:id` — el endpoint que el propio contrato SEND-8 le pide al
 * caller M2M que poleé tras un 409. El poll se auto-429aba.
 */
describe('fix wave F1 (F7) — el rate limiter de escritura NO toca los GET', () => {
  it('40 GET /campaigns/:id seguidos con un limiter de 2/min: ninguno rebota con 429', async () => {
    const built = buildApp({ writeRateLimiter: createExternalWriteRateLimiter({ limit: 2, windowMs: 60_000 }) });
    await seedApiMessagingUser(built.rbacUserRepo);

    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await request(built.app)
        .get('/api/external/v1/messaging/bulk/campaigns/no-existe')
        .set('X-Api-Key', DEDICATED_KEY);
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 429)).toHaveLength(0);
    expect(new Set(statuses)).toEqual(new Set([404])); // negocio, nunca rate limit
  });

  it('los POST SI siguen limitados (el limiter no se desactivo, se re-alcanzo)', async () => {
    const built = buildApp({ writeRateLimiter: createExternalWriteRateLimiter({ limit: 2, windowMs: 60_000 }) });
    await seedApiMessagingUser(built.rbacUserRepo);

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await request(built.app)
        .post('/api/external/v1/messaging/bulk/send')
        .set('X-Api-Key', DEDICATED_KEY)
        .set('Idempotency-Key', `key-${i}`)
        .send({ previewId: 'no-existe' });
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});

/**
 * S2 (smoke en vivo) — LIVE: `DELETE /templates/:sid` → 401 UNAUTHORIZED,
 * `GET /campaigns/` (id vacío) → 401. Ninguna de las 2 rutas está registrada
 * en `createExternalMessagingRouter`, así que Express seguía buscando un
 * match y caía en el mount GLOBAL de `app.ts` (`/api/external/v1`, key
 * GLOBAL sin la key dedicada) — el 401 venía de AHÍ, no de negar la ruta. El
 * router dedicado ahora termina en un catch-all propio (`router.use`) que
 * SELLA el prefijo: nada se escapa. Acá se monta un stub que simula el mount
 * global (401 fijo) DESPUÉS del router dedicado — molde real de `app.ts`
 * (COMP-1: el dedicado se registra ANTES) — para probar que el catch-all
 * intercepta antes de que Express siga cayendo al stub.
 */
describe('fix wave F3 (S2) — el router dedicado queda SELLADO, nada se escapa al mount GLOBAL', () => {
  function buildSealedApp() {
    const built = buildApp();
    built.app.use('/api/external/v1', (_req, res) => {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    });
    return built;
  }

  it('DELETE /templates/:sid (no registrada) → 404 NOT_FOUND, NUNCA el 401 del stub global', async () => {
    const { app } = buildSealedApp();
    const res = await request(app)
      .delete('/api/external/v1/messaging/bulk/templates/HXpending1')
      .set('X-Api-Key', DEDICATED_KEY);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('GET /campaigns/ (id vacío) → 404 NOT_FOUND, NUNCA el 401 del stub global', async () => {
    const { app } = buildSealedApp();
    const res = await request(app)
      .get('/api/external/v1/messaging/bulk/campaigns/')
      .set('X-Api-Key', DEDICATED_KEY);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

/** SEND-6 exige 200 en el REPLAY; 202 queda solo para el `send` que ACEPTA recien. */
describe('fix wave F1 (F3) — codigo HTTP del replay', () => {
  it('replay (misma key + mismo preview) → 200 con {resumed, status}; el primer send seguia siendo 202', async () => {
    const built = buildApp();
    await seedApiMessagingUser(built.rbacUserRepo);
    const preview = await built.previewRepo.create(buildPreviewData({ recipients: ONE_RECIPIENT }));

    const first = await request(built.app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .set('Idempotency-Key', 'key-replay')
      .send({ previewId: preview.id });
    expect(first.status).toBe(202);
    expect(first.body.resumed).toBeUndefined();

    const replay = await request(built.app)
      .post('/api/external/v1/messaging/bulk/send')
      .set('X-Api-Key', DEDICATED_KEY)
      .set('Idempotency-Key', 'key-replay')
      .send({ previewId: preview.id });

    expect(replay.status).toBe(200);
    expect(replay.body.campaignId).toBe(first.body.campaignId);
    expect(replay.body.status).toBe('pending');
  });
});
