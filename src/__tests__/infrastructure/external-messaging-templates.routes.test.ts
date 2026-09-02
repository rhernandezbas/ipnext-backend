/**
 * external-bulk-messaging (task 4.8, TPL-0..TPL-5, D4.f, D7.d, AUDIT-2) —
 * supertest sobre las 4 rutas de templates del router externo, con los use
 * cases REALES (`ListTemplates`/`GetTemplate`/`CreateTemplate`/
 * `SubmitTemplateForApproval` — CERO use case nuevo, D4.f) + un
 * `InMemoryTemplateMessagingGateway` (fake de AMBOS ports de templates). El
 * mismo mapeo de errores que `templates.routes.ts` (D7.d) — no se reimplementa.
 */
import request from 'supertest';
import express from 'express';
import { createExternalMessagingRouter, ExternalMessagingRouterDeps } from '@infrastructure/http/routes/external-messaging.routes';
import { createApiKeyMiddleware } from '@infrastructure/http/middleware/apiKeyMiddleware';
import { auditMutationsMiddleware } from '@infrastructure/http/middleware/auditMutationsMiddleware';
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
import { InMemoryAuditEventRepository } from '@infrastructure/adapters/in-memory/InMemoryAuditEventRepository';
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

const NOW = new Date('2026-09-02T12:00:00.000Z');
const FLAG_KEY = 'messaging-external-bulk-enabled';
const DEDICATED_KEY = 'dedicated-external-messaging-key';

const APPROVED_TEMPLATE: TemplateDto = {
  contentSid: 'HXapproved1',
  friendlyName: 'promo_setiembre',
  language: 'es',
  variables: { '1': 'Nombre' },
  approvalStatus: 'approved',
  category: 'MARKETING',
  body: 'Hola {{1}}',
};

const PENDING_TEMPLATE: TemplateDto = {
  contentSid: 'HXpending1',
  friendlyName: 'recordatorio_deuda',
  language: 'es',
  variables: {},
  approvalStatus: 'pending',
  body: 'Recordatorio',
};

function makeSegmentSource(): CampaignSegmentSource {
  return { listSegmentRecipients: async (_s: CampaignSegmentFilter) => [] };
}

class FakeCampaignStarter implements CampaignStarter {
  async start(_campaignId: string): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
}

function buildApp(opts: { templates?: TemplateDto[]; flagEnabled?: boolean; withAudit?: boolean } = {}) {
  const previewRepo = new InMemoryExternalBulkPreviewRepository({ now: () => NOW });
  const configRepo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
  const campaignRepo = new InMemoryCampaignRepository({ now: () => NOW });
  const templatePort = new InMemoryTemplateMessagingGateway({
    templates: opts.templates ?? [APPROVED_TEMPLATE, PENDING_TEMPLATE],
  });
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
  const auditRepo = new InMemoryAuditEventRepository();
  if (opts.withAudit) app.use(auditMutationsMiddleware(auditRepo));
  app.use('/api/external/v1/messaging/bulk', createApiKeyMiddleware(DEDICATED_KEY), createExternalMessagingRouter(deps));
  app.use(errorHandler);

  return { app, templatePort, auditRepo };
}

const BASE = '/api/external/v1/messaging/bulk';

describe('GET /templates (TPL-1)', () => {
  it('200 con TODOS los templates (mixto approved/pending), sendable correcto, variables[] y body', async () => {
    const { app } = buildApp();
    const res = await request(app).get(`${BASE}/templates`).set('X-Api-Key', DEDICATED_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const approved = res.body.data.find((t: { contentSid: string }) => t.contentSid === 'HXapproved1');
    const pending = res.body.data.find((t: { contentSid: string }) => t.contentSid === 'HXpending1');
    expect(approved.sendable).toBe(true);
    expect(approved.variables).toEqual(['1']);
    expect(approved.body).toBe('Hola {{1}}');
    expect(pending.sendable).toBe(false);
  });
});

describe('GET /templates/:sid (TPL-2)', () => {
  it('200 con el DTO curado para un sid existente', async () => {
    const { app } = buildApp();
    const res = await request(app).get(`${BASE}/templates/HXpending1`).set('X-Api-Key', DEDICATED_KEY);
    expect(res.status).toBe(200);
    expect(res.body.approvalStatus).toBe('pending');
    expect(res.body.sendable).toBe(false);
  });

  it('404 TEMPLATE_NOT_FOUND para un sid desconocido', async () => {
    const { app } = buildApp();
    const res = await request(app).get(`${BASE}/templates/HXnope`).set('X-Api-Key', DEDICATED_KEY);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
  });
});

describe('POST /templates (TPL-3)', () => {
  it('201 con approvalStatus:unsubmitted; el port de submit NUNCA se invoca', async () => {
    const { app, templatePort } = buildApp();
    const res = await request(app)
      .post(`${BASE}/templates`)
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ friendlyName: 'promo_octubre', language: 'es', body: 'Hola {{1}}', variables: ['1'] });
    expect(res.status).toBe(201);
    expect(res.body.approvalStatus).toBe('unsubmitted');
    expect(templatePort.submitCalls).toHaveLength(0);
  });

  it('body vacío/whitespace → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`${BASE}/templates`)
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ friendlyName: 'x', language: 'es', body: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('category fuera del enum → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`${BASE}/templates`)
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ friendlyName: 'x', language: 'es', body: 'y', category: 'PROMO' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('tipo equivocado (friendlyName numérico) → 400 con mensaje de TIPO, no "es requerido" (D7.d)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`${BASE}/templates`)
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ friendlyName: 123, language: 'es', body: 'y' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    // zod reporta el TIPO recibido — nunca el mensaje "friendlyName es requerido"
    // del casting defensivo que `templates.routes.ts` NO usa acá (D7.d).
    const messages = JSON.stringify(res.body.details ?? []);
    expect(messages.toLowerCase()).not.toContain('es requerido');
  });
});

describe('POST /templates/:sid/submit (TPL-4)', () => {
  it('202 {contentSid, submitted:true}; el port recibió el name normalizado', async () => {
    const { app, templatePort } = buildApp();
    const res = await request(app)
      .post(`${BASE}/templates/HXpending1/submit`)
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ name: 'Promo SETIEMBRE #1', category: 'MARKETING' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ contentSid: 'HXpending1', submitted: true });
    expect(templatePort.submitCalls[0]).toMatchObject({
      contentSid: 'HXpending1',
      name: 'promo_setiembre_1',
      category: 'MARKETING',
    });
  });

  it('name que normaliza a vacío → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`${BASE}/templates/HXpending1/submit`)
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ name: '###', category: 'UTILITY' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('category inválida → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`${BASE}/templates/HXpending1/submit`)
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ name: 'ok', category: 'PROMO' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('sid inexistente → 404 TEMPLATE_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`${BASE}/templates/HXnope/submit`)
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ name: 'ok', category: 'MARKETING' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
  });
});

describe('DELETE /templates/:sid (TPL-5)', () => {
  it('404 — la ruta NO está registrada, deleteTemplate NUNCA se invoca', async () => {
    const { app, templatePort } = buildApp();
    const res = await request(app).delete(`${BASE}/templates/HXpending1`).set('X-Api-Key', DEDICATED_KEY);
    expect(res.status).toBe(404);
    expect(templatePort.deleteCalls).toHaveLength(0);
  });
});

describe('TPL-0 — key dedicada y kill-switch aplican a las 4 rutas', () => {
  it('flag OFF → 403 FEATURE_DISABLED en las 4 rutas, sin tocar el proveedor', async () => {
    const { app, templatePort } = buildApp({ flagEnabled: false });

    const list = await request(app).get(`${BASE}/templates`).set('X-Api-Key', DEDICATED_KEY);
    expect(list.status).toBe(403);
    expect(list.body.code).toBe('FEATURE_DISABLED');

    const get = await request(app).get(`${BASE}/templates/HXapproved1`).set('X-Api-Key', DEDICATED_KEY);
    expect(get.status).toBe(403);

    const create = await request(app)
      .post(`${BASE}/templates`)
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ friendlyName: 'x', language: 'es', body: 'y' });
    expect(create.status).toBe(403);
    expect(templatePort.createCalls).toHaveLength(0);

    const submit = await request(app)
      .post(`${BASE}/templates/HXapproved1/submit`)
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ name: 'x', category: 'MARKETING' });
    expect(submit.status).toBe(403);
    expect(templatePort.submitCalls).toHaveLength(0);
  });

  it('key global (equivocada acá) → 401 en GET /templates', async () => {
    const { app } = buildApp();
    const res = await request(app).get(`${BASE}/templates`).set('X-Api-Key', 'not-the-dedicated-key');
    expect(res.status).toBe(401);
  });

  it('sin key → 401 en GET /templates', async () => {
    const { app } = buildApp();
    const res = await request(app).get(`${BASE}/templates`);
    expect(res.status).toBe(401);
  });
});

describe('AUDIT-2 — los POST de templates quedan auditados, los GET no', () => {
  it('POST /templates exitoso pasa por auditMutationsMiddleware sin excepción', async () => {
    const { app, auditRepo } = buildApp({ withAudit: true });
    const res = await request(app)
      .post(`${BASE}/templates`)
      .set('X-Api-Key', DEDICATED_KEY)
      .send({ friendlyName: 'promo_audit', language: 'es', body: 'Hola' });
    expect(res.status).toBe(201);
    await new Promise((resolve) => setImmediate(resolve));
    const page = await auditRepo.list({ page: 1, pageSize: 10 });
    expect(page.total).toBeGreaterThanOrEqual(1);
  });

  it('GET /templates NO genera mutación auditada', async () => {
    const { app, auditRepo } = buildApp({ withAudit: true });
    const res = await request(app).get(`${BASE}/templates`).set('X-Api-Key', DEDICATED_KEY);
    expect(res.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    const page = await auditRepo.list({ page: 1, pageSize: 10 });
    expect(page.total).toBe(0);
  });
});
