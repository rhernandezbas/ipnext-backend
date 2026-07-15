/**
 * Change 3 (templates CRUD, T4) — `/api/messaging/templates` route integration
 * tests. SEAM COMPLETO: use cases REALES (Create/List/Get/Submit/Delete) + fakes
 * in-memory de `TemplateAdminPort` (`InMemoryTemplateMessagingGateway`) y de
 * `ActiveCampaignLookup` (`InMemoryCampaignRepository`) + `errorHandler` REAL —
 * NUNCA se mockea un use case (mismo convenio que `messagingBulk.routes.test.ts`).
 *
 * RBAC doble capa: read (list/get) = `messaging.templates`; write (create/submit/
 * delete) = `messaging.bulk`. Mocks de auth/perms igual que el molde bulk.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { createMessagingTemplatesRouter, MessagingTemplatesRoutePerms } from '@infrastructure/http/routes/templates.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { CreateTemplate } from '@application/use-cases/messaging/CreateTemplate';
import { ListTemplates } from '@application/use-cases/messaging/ListTemplates';
import { GetTemplate } from '@application/use-cases/messaging/GetTemplate';
import { SubmitTemplateForApproval } from '@application/use-cases/messaging/SubmitTemplateForApproval';
import { DeleteTemplate } from '@application/use-cases/messaging/DeleteTemplate';
import { InMemoryTemplateMessagingGateway } from '@infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import type { TemplateDto } from '@domain/ports/TemplateMessagingPort';

const SEED: TemplateDto = {
  contentSid: 'HXseed',
  friendlyName: 'seed',
  language: 'es',
  variables: { '1': 'nombre' },
  approvalStatus: 'approved',
  category: 'UTILITY',
  body: 'Hola {{1}}',
};

const allowAuth = (req: Request, _res: Response, next: NextFunction) => {
  (req as unknown as { user: { id: string } }).user = { id: 'user-test' };
  next();
};
const denyAuth: RequestHandler = (_req, res) => {
  res.status(401).json({ error: 'UNAUTHORIZED', code: 'NO_USER_CONTEXT' });
};
const allowPerm: RequestHandler = (_req, _res, next) => next();
const denyPerm: RequestHandler = (_req, res) => {
  res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED' });
};

interface BuildAppOptions {
  bulkPerm?: RequestHandler;
  templatesPerm?: RequestHandler;
  templates?: TemplateDto[];
  campaignRepo?: InMemoryCampaignRepository;
  auth?: RequestHandler;
}

function buildApp(opts: BuildAppOptions = {}) {
  const gw = new InMemoryTemplateMessagingGateway({ templates: opts.templates ?? [SEED] });
  const campaignRepo = opts.campaignRepo ?? new InMemoryCampaignRepository();
  const perms: MessagingTemplatesRoutePerms = {
    bulk: opts.bulkPerm ?? allowPerm,
    templates: opts.templatesPerm ?? allowPerm,
  };

  const app = express();
  app.use(express.json());
  app.use(
    '/api/messaging/templates',
    createMessagingTemplatesRouter(
      new CreateTemplate(gw),
      new ListTemplates(gw),
      new GetTemplate(gw),
      new SubmitTemplateForApproval(gw),
      new DeleteTemplate(gw, campaignRepo),
      opts.auth ?? allowAuth,
      perms,
    ),
  );
  app.use(errorHandler);
  return { app, gw, campaignRepo };
}

// ─── Auth (401 sin auth) ─────────────────────────────────────────────────────
describe('/api/messaging/templates — auth', () => {
  it('sin auth → 401 en cualquier ruta', async () => {
    const { app } = buildApp({ auth: denyAuth });
    const res = await request(app).get('/api/messaging/templates');
    expect(res.status).toBe(401);
  });
});

// ─── GET / (list) — RBAC read=messaging.templates ───────────────────────────
describe('/api/messaging/templates — GET / (list)', () => {
  it('200 {data:[...]} con sendable por template', async () => {
    const pending: TemplateDto = { ...SEED, contentSid: 'HXpending', approvalStatus: 'pending' };
    const { app } = buildApp({ templates: [SEED, pending] });
    const res = await request(app).get('/api/messaging/templates');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.find((t: { contentSid: string }) => t.contentSid === 'HXseed').sendable).toBe(true);
    expect(res.body.data.find((t: { contentSid: string }) => t.contentSid === 'HXpending').sendable).toBe(false);
  });

  it('sin messaging.templates → 403', async () => {
    const { app } = buildApp({ templatesPerm: denyPerm });
    const res = await request(app).get('/api/messaging/templates');
    expect(res.status).toBe(403);
  });
});

// ─── GET /:sid (ficha) ──────────────────────────────────────────────────────
describe('/api/messaging/templates — GET /:sid', () => {
  it('existe → 200 DTO curado', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/templates/HXseed');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ contentSid: 'HXseed', sendable: true, body: 'Hola {{1}}' });
    expect(res.body).not.toHaveProperty('types');
  });

  it('inexistente → 404 TEMPLATE_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/templates/HXnope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('sin messaging.templates → 403', async () => {
    const { app } = buildApp({ templatesPerm: denyPerm });
    const res = await request(app).get('/api/messaging/templates/HXseed');
    expect(res.status).toBe(403);
  });
});

// ─── POST / (create) — RBAC write=messaging.bulk ────────────────────────────
describe('/api/messaging/templates — POST / (create)', () => {
  it('input válido → 201 DTO curado; persiste en el gateway con el shape de proveedor', async () => {
    const { app, gw } = buildApp();
    const res = await request(app)
      .post('/api/messaging/templates')
      .send({ friendlyName: 'recordatorio', language: 'es', category: 'UTILITY', body: 'Hola {{1}}', variables: ['1'] });
    expect(res.status).toBe(201);
    expect(res.body.contentSid).toMatch(/^HX/);
    expect(res.body.friendlyName).toBe('recordatorio');
    expect(res.body).not.toHaveProperty('types');
    expect(gw.createCalls[0]).toEqual({ friendlyName: 'recordatorio', language: 'es', variables: { '1': '1' }, body: 'Hola {{1}}' });
  });

  it('body vacío → 400 VALIDATION_ERROR, no crea', async () => {
    const { app, gw } = buildApp();
    const res = await request(app).post('/api/messaging/templates').send({ friendlyName: 'x', language: 'es', body: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(gw.createCalls).toHaveLength(0);
  });

  it('category inválida → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/messaging/templates').send({ friendlyName: 'x', language: 'es', body: 'b', category: 'PROMO' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('sin messaging.bulk → 403', async () => {
    const { app } = buildApp({ bulkPerm: denyPerm });
    const res = await request(app).post('/api/messaging/templates').send({ friendlyName: 'x', language: 'es', body: 'b' });
    expect(res.status).toBe(403);
  });
});

// ─── POST /:sid/submit — RBAC write=messaging.bulk ──────────────────────────
describe('/api/messaging/templates — POST /:sid/submit', () => {
  it('category válida + name → 202', async () => {
    const { app, gw } = buildApp({ templates: [{ ...SEED, approvalStatus: 'unsubmitted' }] });
    const res = await request(app).post('/api/messaging/templates/HXseed/submit').send({ name: 'Promo Julio', category: 'MARKETING' });
    expect(res.status).toBe(202);
    expect(gw.submitCalls).toEqual([{ contentSid: 'HXseed', name: 'promo_julio', category: 'MARKETING' }]);
  });

  it('category inválida → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/messaging/templates/HXseed/submit').send({ name: 'x', category: 'PROMO' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('sin messaging.bulk → 403', async () => {
    const { app } = buildApp({ bulkPerm: denyPerm });
    const res = await request(app).post('/api/messaging/templates/HXseed/submit').send({ name: 'x', category: 'UTILITY' });
    expect(res.status).toBe(403);
  });
});

// ─── DELETE /:sid — RBAC write=messaging.bulk + guard campañas ──────────────
describe('/api/messaging/templates — DELETE /:sid', () => {
  it('sin campañas activas → 204, borra', async () => {
    const { app, gw } = buildApp();
    const res = await request(app).delete('/api/messaging/templates/HXseed');
    expect(res.status).toBe(204);
    expect(gw.deleteCalls).toEqual([{ contentSid: 'HXseed', deleteInWaba: true }]);
  });

  it('con campaña pending usando ese contentSid → 409 TEMPLATE_IN_USE, NO borra', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    await campaignRepo.create({ name: 'c', templateRef: 'HXseed', segment: { statuses: ['late'] }, variableSpec: {}, total: 1, createdById: 'u' });
    const { app, gw } = buildApp({ campaignRepo });
    const res = await request(app).delete('/api/messaging/templates/HXseed');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEMPLATE_IN_USE');
    // Fix wave (🟡#2) — el body expone CUÁLES campañas retienen el template.
    expect(Array.isArray(res.body.campaignIds)).toBe(true);
    expect(res.body.campaignIds).toHaveLength(1);
    expect(gw.deleteCalls).toHaveLength(0);
  });

  it('sin messaging.bulk → 403', async () => {
    const { app } = buildApp({ bulkPerm: denyPerm });
    const res = await request(app).delete('/api/messaging/templates/HXseed');
    expect(res.status).toBe(403);
  });

  it('RBAC-2: con messaging.templates pero SIN messaging.bulk → DELETE 403 (permisos separados)', async () => {
    const { app } = buildApp({ templatesPerm: allowPerm, bulkPerm: denyPerm });
    const res = await request(app).delete('/api/messaging/templates/HXseed');
    expect(res.status).toBe(403);
  });
});
