/**
 * messaging-bulk (F2, Batch 7, T7.2) — `/api/messaging/bulk` route integration
 * tests. Seam COMPLETO: use cases REALES (ListTemplates/PreviewCampaignSegment/
 * CreateCampaign/GetCampaign/ListCampaigns) + `InMemoryCampaignRepository` +
 * fakes in-memory de `TemplateMessagingPort`/`CampaignSegmentSource`
 * (T3.2/T3.3 pattern) + `errorHandler` REAL — NUNCA se mockea un use case
 * (mismo convenio que `messaging.routes.test.ts`/`actions.routes.test.ts`).
 *
 * `CampaignRunner` es REAL (con `InMemoryCampaignRepository` +
 * `InMemoryDistributedLock`) — solo su dependencia interna `SendCampaign` es
 * un stub `{execute: jest.fn()}` (mismo criterio que `CampaignRunner.test.ts`,
 * T4.4): el propósito de ESTE archivo es pinear rutas/RBAC/wiring de errores,
 * no re-testear el loop de envío (ya cubierto por `SendCampaign.test.ts`).
 *
 * Prefijo `/api/messaging/bulk` (spec manda — tasks.md contradicción #1).
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  createMessagingBulkRouter,
  MessagingBulkRoutePerms,
} from '../../infrastructure/http/routes/messagingBulk.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { ListTemplates } from '../../application/use-cases/messaging/ListTemplates';
import { PreviewCampaignSegment } from '../../application/use-cases/messaging/PreviewCampaignSegment';
import { ListSegmentRecipients } from '../../application/use-cases/messaging/ListSegmentRecipients';
import { CreateCampaign } from '../../application/use-cases/messaging/CreateCampaign';
import { AuthorizeCampaignSend } from '../../application/use-cases/messaging/AuthorizeCampaignSend';
import { MAX_MANUAL_RECIPIENTS, MAX_MANUAL_CONTACTS } from '../../application/use-cases/messaging/resolveCombinedRecipients';
import { GetCampaign } from '../../application/use-cases/messaging/GetCampaign';
import { ListCampaigns } from '../../application/use-cases/messaging/ListCampaigns';
import { InMemoryCampaignRepository } from '../../infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import { InMemoryDistributedLock } from '../../infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { CampaignRunner, CampaignSender, CAMPAIGN_LOCK_KEY } from '../../infrastructure/scheduling/CampaignRunner';
import type { CampaignSegmentSource, CampaignRecipientCandidate, ManualRecipientSource } from '../../domain/ports/CustomerRepository';
import type { TemplateMessagingPort, TemplateDto } from '../../domain/ports/TemplateMessagingPort';
import type { Campaign } from '../../domain/entities/campaign';

// ─── Fakes (T3.2/T3.3 pattern — inline mínimo, NO InMemoryCustomerRepository) ────

function makeSegmentSource(candidates: CampaignRecipientCandidate[]): CampaignSegmentSource {
  return { listSegmentRecipients: jest.fn().mockResolvedValue(candidates) };
}

/** manual-recipients — fake del port narrow para la lista manual (subset por id). */
function makeManualSource(candidates: CampaignRecipientCandidate[]): ManualRecipientSource {
  return {
    findRecipientCandidatesByIds: jest.fn(async (ids: string[]) =>
      candidates.filter((c) => ids.includes(c.clientId)),
    ),
  };
}

function makeTemplatePort(templates: TemplateDto[]): TemplateMessagingPort {
  return {
    listTemplates: jest.fn().mockResolvedValue(templates),
    sendTemplate: jest.fn(),
  };
}

function makeCandidate(overrides: Partial<CampaignRecipientCandidate> = {}): CampaignRecipientCandidate {
  return {
    clientId: 'c-default',
    name: 'Default',
    phone: '3364000000',
    balanceDue: 1000,
    whatsappOptOutAt: null,
    ...overrides,
  };
}

const APPROVED_TEMPLATE: TemplateDto = {
  contentSid: 'HXapproved',
  friendlyName: 'recordatorio_deuda',
  language: 'es',
  variables: { '1': 'nombre', '2': 'monto_deuda' },
  approvalStatus: 'approved',
  body: 'Hola {{1}}, tenés un saldo pendiente de {{2}}',
};

const PENDING_TEMPLATE: TemplateDto = {
  contentSid: 'HXpending',
  friendlyName: 'promo_pendiente',
  language: 'es',
  variables: {},
  approvalStatus: 'pending',
  body: '',
};

// ─── Auth + RBAC mock helpers (mismo idioma que messaging.routes.test.ts) ───────

const allowAuth = (req: Request, _res: Response, next: NextFunction) => {
  (req as any).user = { id: 'user-test', email: 'test@test.com' };
  next();
};

const allowPerm: RequestHandler = (_req, _res, next) => next();
const denyPerm: RequestHandler = (_req, res) => {
  res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED' });
};

interface BuildAppOptions {
  bulkPerm?: RequestHandler;
  templatesPerm?: RequestHandler;
  templates?: TemplateDto[];
  segmentCandidates?: CampaignRecipientCandidate[];
  /** manual-recipients — universo de clientes resolvibles por la lista manual. */
  manualCandidates?: CampaignRecipientCandidate[];
  campaignRepo?: InMemoryCampaignRepository;
  sendCampaign?: CampaignSender;
  /**
   * bulk-granular-perms — acciones `messaging` que devuelve el resolver del router.
   * Default `['*']` (super_admin-equivalente) → todos los tests previos siguen
   * verdes sin tocarse. Un test que quiera EJERCITAR el bloqueo granular pasa un
   * subset (ej. `['bulk']` sin `bulk_blocked`).
   */
  bulkActions?: string[];
}

function buildApp(opts: BuildAppOptions = {}) {
  const campaignRepo = opts.campaignRepo ?? new InMemoryCampaignRepository();
  const templatePort = makeTemplatePort(opts.templates ?? [APPROVED_TEMPLATE]);
  const segmentSource = makeSegmentSource(opts.segmentCandidates ?? [makeCandidate()]);
  // manual-recipients — misma instancia inyectada a Preview + Create (mismo
  // criterio que app.ts, donde customerAdapter sirve ambos ports).
  const manualSource = makeManualSource(opts.manualCandidates ?? []);

  const listTemplates = new ListTemplates(templatePort);
  const previewCampaignSegment = new PreviewCampaignSegment(segmentSource, manualSource);
  // bulk-csv-recipients (DET-1) — 2do arg manualRecipientSource (cierra deuda F4).
  const listSegmentRecipients = new ListSegmentRecipients(segmentSource, manualSource);
  const createCampaign = new CreateCampaign(campaignRepo, segmentSource, templatePort, manualSource);
  const getCampaign = new GetCampaign(campaignRepo);
  const listCampaigns = new ListCampaigns(campaignRepo);

  const lock = new InMemoryDistributedLock();
  const sendCampaign: CampaignSender = opts.sendCampaign ?? { execute: jest.fn().mockResolvedValue(undefined) };
  const campaignRunner = new CampaignRunner(sendCampaign, campaignRepo, lock);

  // bulk-granular-perms — AuthorizeCampaignSend real (lee el snapshot de la campaña)
  // + resolver de acciones. Default ['*'] = super_admin → los tests previos no cambian.
  const authorizeCampaignSend = new AuthorizeCampaignSend(campaignRepo);
  const resolveBulkActions = async (_userId: string): Promise<string[]> => opts.bulkActions ?? ['*'];

  const perms: MessagingBulkRoutePerms = {
    bulk: opts.bulkPerm ?? allowPerm,
    templates: opts.templatesPerm ?? allowPerm,
  };

  const app = express();
  // bulk-csv-recipients (CSV-5) — el default de express.json() (100kb) se queda
  // corto para un `manualContacts` de miles de filas `{name, phone}` (a diferencia
  // de `manualClientIds`, un array de strings cortos). Bump LOCAL de test —
  // legítimo para EJERCITAR la lógica de negocio (422, resolución) en aislamiento;
  // NO pinea el comportamiento real de prod (ese es el trabajo de
  // `messaging-bulk-composition.test.ts` (k) + `messagingBulk.dualParser.e2e.test.ts`).
  //
  // ── fix wave (C1, CRITICAL) ────────────────────────────────────────────────
  // Este bump local en su momento TAPÓ un bug real: `app.ts` (línea ~884, antes
  // del fix) montaba el `express.json()` global SIN límite propio para
  // `/api/messaging/bulk` — un CSV real (~2000 filas ya pasan 100kb) recibía 413
  // ANTES del router en prod, y el 422 de este mismo test file (CSV-5 (c)) era
  // inalcanzable fuera de la suite. Fix: `app.ts` ahora registra un
  // `express.json({ limit: '2mb' })` path-scoped a `/api/messaging/bulk` ANTES
  // del global (molde tickets/messaging-inbox). Ese fix REAL está pineado por
  // `messaging-bulk-composition.test.ts` (k) (estático, contra el source de
  // `app.ts`) y probado FUNCIONALMENTE por `messagingBulk.dualParser.e2e.test.ts`
  // (un payload >100kb NO 413ea bajo el PROD ORDER real).
  app.use(express.json({ limit: '2mb' }));
  app.use(
    '/api/messaging/bulk',
    createMessagingBulkRouter(
      listTemplates,
      previewCampaignSegment,
      listSegmentRecipients,
      createCampaign,
      campaignRunner,
      getCampaign,
      listCampaigns,
      allowAuth,
      perms,
      authorizeCampaignSend,
      resolveBulkActions,
    ),
  );
  app.use(errorHandler);

  return { app, campaignRepo, templatePort, segmentSource, campaignRunner, lock };
}

async function seedDoneCampaign(campaignRepo: InMemoryCampaignRepository): Promise<Campaign> {
  const campaign = await campaignRepo.create({
    name: 'ya terminada',
    templateRef: 'HXapproved',
    segment: { statuses: ['late'] },
    variableSpec: {},
    total: 1,
    createdById: 'user-test',
  });
  return campaignRepo.update(campaign.id, { status: 'done', finishedAt: new Date().toISOString() });
}

// ─── TPL-1 — listado de templates ────────────────────────────────────────────────

describe('/api/messaging/bulk — GET /templates (TPL-1)', () => {
  it('listado mixto approved/pending — cada uno con approvalStatus + sendable correcto', async () => {
    const { app } = buildApp({ templates: [APPROVED_TEMPLATE, PENDING_TEMPLATE] });

    const res = await request(app).get('/api/messaging/bulk/templates');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const approved = res.body.data.find((t: any) => t.contentSid === 'HXapproved');
    const pending = res.body.data.find((t: any) => t.contentSid === 'HXpending');
    expect(approved.sendable).toBe(true);
    expect(pending.sendable).toBe(false);
  });
});

// ─── RBAC-1 — messaging.bulk gatea preview/create/send/historial ───────────────

describe('/api/messaging/bulk — RBAC-1 (sin messaging.bulk → 403, sin efectos)', () => {
  it('POST /segment/preview → 403', async () => {
    const { app } = buildApp({ bulkPerm: denyPerm });
    const res = await request(app).post('/api/messaging/bulk/segment/preview').send({ statuses: ['late'] });
    expect(res.status).toBe(403);
  });

  // ── messaging-bulk v1.1 (preview modal paginado) — /segment/recipients ──────
  it('POST /segment/recipients → 403', async () => {
    const { app } = buildApp({ bulkPerm: denyPerm });
    const res = await request(app).post('/api/messaging/bulk/segment/recipients').send({ statuses: ['late'] });
    expect(res.status).toBe(403);
  });

  it('GET /segment/recipients → 403', async () => {
    const { app } = buildApp({ bulkPerm: denyPerm });
    const res = await request(app).get('/api/messaging/bulk/segment/recipients').query({ statuses: 'late' });
    expect(res.status).toBe(403);
  });

  it('POST /campaigns → 403, no crea Campaign', async () => {
    const { app, campaignRepo } = buildApp({ bulkPerm: denyPerm });
    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: ['late'] },
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });
    expect(res.status).toBe(403);
    const list = await campaignRepo.list({ page: 1, limit: 10 });
    expect(list.total).toBe(0);
  });

  it('POST /campaigns/:id/send → 403, no dispara el envío', async () => {
    const { app, campaignRepo, campaignRunner } = buildApp({ bulkPerm: denyPerm });
    const campaign = await campaignRepo.create({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: [] }, variableSpec: {}, total: 1, createdById: 'u',
    });
    const res = await request(app).post(`/api/messaging/bulk/campaigns/${campaign.id}/send`);
    expect(res.status).toBe(403);
    const fresh = await campaignRepo.findById(campaign.id);
    expect(fresh?.status).toBe('pending');
    void campaignRunner;
  });

  it('GET /campaigns/:id → 403', async () => {
    const { app, campaignRepo } = buildApp({ bulkPerm: denyPerm });
    const campaign = await campaignRepo.create({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: [] }, variableSpec: {}, total: 1, createdById: 'u',
    });
    const res = await request(app).get(`/api/messaging/bulk/campaigns/${campaign.id}`);
    expect(res.status).toBe(403);
  });

  it('GET /campaigns → 403', async () => {
    const { app } = buildApp({ bulkPerm: denyPerm });
    const res = await request(app).get('/api/messaging/bulk/campaigns');
    expect(res.status).toBe(403);
  });
});

// ─── RBAC-2 — messaging.templates independiente de messaging.bulk ─────────────

describe('/api/messaging/bulk — RBAC-2 (permisos separados, uno no implica el otro)', () => {
  it('con messaging.bulk pero SIN messaging.templates → GET /templates 403', async () => {
    const { app } = buildApp({ bulkPerm: allowPerm, templatesPerm: denyPerm });
    const res = await request(app).get('/api/messaging/bulk/templates');
    expect(res.status).toBe(403);
  });

  it('con messaging.templates pero SIN messaging.bulk → POST /campaigns 403', async () => {
    const { app } = buildApp({ bulkPerm: denyPerm, templatesPerm: allowPerm });
    const res = await request(app).post('/api/messaging/bulk/campaigns').send({});
    expect(res.status).toBe(403);
  });
});

// ─── CAMP-2/3/4 vía HTTP ─────────────────────────────────────────────────────────

describe('/api/messaging/bulk — POST /campaigns (CAMP-2/3/4)', () => {
  it('CAMP-2 — templateRef pending → 422 TEMPLATE_NOT_APPROVED', async () => {
    const { app } = buildApp({ templates: [PENDING_TEMPLATE], segmentCandidates: [makeCandidate()] });
    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x', templateRef: 'HXpending', segment: { statuses: ['late'] }, variablesMap: {},
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TEMPLATE_NOT_APPROVED');
  });

  it('CAMP-3 — falta una variable requerida → 422 MISSING_TEMPLATE_VARIABLES con `missing`', async () => {
    const { app } = buildApp({ templates: [APPROVED_TEMPLATE], segmentCandidates: [makeCandidate()] });
    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: ['late'] },
      variablesMap: { '1': { source: 'name' } }, // falta '2' (monto_deuda)
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MISSING_TEMPLATE_VARIABLES');
    expect(res.body.missing).toEqual(['2']);
  });

  it('CAMP-4 — segmento vacío → 422 EMPTY_SEGMENT', async () => {
    const { app } = buildApp({ templates: [APPROVED_TEMPLATE], segmentCandidates: [] });
    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: ['late'] },
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EMPTY_SEGMENT');
  });
});

// ─── HIST-2 — detalle de campaña ────────────────────────────────────────────────

describe('/api/messaging/bulk — GET /campaigns/:id (HIST-2)', () => {
  it('campaña inexistente → 404 CAMPAIGN_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/bulk/campaigns/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CAMPAIGN_NOT_FOUND');
  });
});

// ─── SEND-1 escenario 2 vía HTTP ─────────────────────────────────────────────────

describe('/api/messaging/bulk — POST /campaigns/:id/send (SEND-1 escenario 2)', () => {
  it('campaña ya `done` → 409 CAMPAIGN_ALREADY_FINISHED', async () => {
    const { app, campaignRepo } = buildApp();
    const campaign = await seedDoneCampaign(campaignRepo);

    const res = await request(app).post(`/api/messaging/bulk/campaigns/${campaign.id}/send`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CAMPAIGN_ALREADY_FINISHED');
  });
});

// ─── FIX-13: happy-path del seam HTTP (control→ruta→use case REAL→repo) ──────────
describe('/api/messaging/bulk — happy-path del seam (FIX-13)', () => {
  it('POST /segment/preview → 200 con count/sample/skipped; mapea statuses[]+balance del body al DTO', async () => {
    const { app, segmentSource } = buildApp({
      segmentCandidates: [
        makeCandidate({ clientId: 'c1', phone: '3364111111', balanceDue: 5000 }),
        makeCandidate({ clientId: 'c2', phone: '3364222222', balanceDue: 8000 }),
      ],
    });

    const res = await request(app)
      .post('/api/messaging/bulk/segment/preview')
      .send({ statuses: ['late', 'blocked'], balanceMin: 1000, balanceMax: 100000 });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(Array.isArray(res.body.sample)).toBe(true);
    expect(res.body.skipped).toEqual({ optedOut: 0, duplicatePhone: 0, invalidPhone: 0 });
    // el body→DTO efectivamente llegó a la fuente narrow:
    expect(segmentSource.listSegmentRecipients).toHaveBeenCalledWith({
      statuses: ['late', 'blocked'],
      balanceMin: 1000,
      balanceMax: 100000,
    });
  });

  it('POST /campaigns → 201 {campaignId,total,status:pending}; persiste campaña+recipients y mapea el segment', async () => {
    const { app, campaignRepo, segmentSource } = buildApp({
      segmentCandidates: [
        makeCandidate({ clientId: 'c1', phone: '3364111111' }),
        makeCandidate({ clientId: 'c2', phone: '3364222222' }),
      ],
    });

    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'Recordatorio julio',
      templateRef: 'HXapproved',
      segment: { statuses: ['late'] },
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.total).toBe(2);
    expect(typeof res.body.campaignId).toBe('string');

    const persisted = await campaignRepo.findById(res.body.campaignId);
    expect(persisted?.name).toBe('Recordatorio julio');
    expect(persisted?.createdById).toBe('user-test'); // del usuario auth, NO del body
    const recipients = await campaignRepo.listRecipients(res.body.campaignId);
    expect(recipients.total).toBe(2);
    expect(segmentSource.listSegmentRecipients).toHaveBeenCalledWith({
      statuses: ['late'],
      balanceMin: undefined,
      balanceMax: undefined,
    });
  });

  it('POST /campaigns/:id/send → 202 {accepted:true} con el lock libre', async () => {
    const { app, campaignRepo } = buildApp();
    const campaign = await campaignRepo.create({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: ['late'] }, variableSpec: {}, total: 1, createdById: 'u',
    });

    const res = await request(app).post(`/api/messaging/bulk/campaigns/${campaign.id}/send`);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ campaignId: campaign.id, accepted: true });
  });

  it('GET /campaigns/:id?includeRecipients=true&status=queued&page&limit → 200 con recipients paginados', async () => {
    const { app, campaignRepo } = buildApp();
    const campaign = await campaignRepo.create({
      name: 'detalle', templateRef: 'HXapproved', segment: { statuses: ['late'] }, variableSpec: {}, total: 2, createdById: 'u',
    });
    await campaignRepo.bulkCreateRecipients(campaign.id, [
      { clientId: 'c1', phoneNormalized: '3364111111', phoneE164: '+5493364111111' },
      { clientId: 'c2', phoneNormalized: '3364222222', phoneE164: '+5493364222222' },
    ]);

    const res = await request(app)
      .get(`/api/messaging/bulk/campaigns/${campaign.id}`)
      .query({ includeRecipients: 'true', status: 'queued', page: '1', limit: '10' });

    expect(res.status).toBe(200);
    expect(res.body.campaign.id).toBe(campaign.id);
    expect(res.body.recipients.total).toBe(2);
    expect(res.body.recipients.page).toBe(1);
    expect(res.body.recipients.limit).toBe(10);
    expect(res.body.recipients.data).toHaveLength(2);
  });

  it('GET /campaigns/:id sin includeRecipients → 200 sin recipients (no pagina)', async () => {
    const { app, campaignRepo } = buildApp();
    const campaign = await campaignRepo.create({
      name: 'h', templateRef: 'HXapproved', segment: { statuses: ['late'] }, variableSpec: {}, total: 0, createdById: 'u',
    });

    const res = await request(app).get(`/api/messaging/bulk/campaigns/${campaign.id}`);
    expect(res.status).toBe(200);
    expect(res.body.recipients).toBeUndefined();
  });

  it('GET /campaigns?page&limit → 200 paginado (mapea page/limit de la query)', async () => {
    const { app, campaignRepo } = buildApp();
    for (const name of ['a', 'b', 'c']) {
      await campaignRepo.create({
        name, templateRef: 'HXapproved', segment: { statuses: ['late'] }, variableSpec: {}, total: 1, createdById: 'u',
      });
    }

    const res = await request(app).get('/api/messaging/bulk/campaigns').query({ page: '1', limit: '2' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(2);
    expect(res.body.data).toHaveLength(2);
  });
});

// ─── manual-recipients (MAN-1/MAN-3): POST /campaigns con lista manual ──────────
describe('/api/messaging/bulk — POST /campaigns con manualClientIds (MAN-1/MAN-3)', () => {
  it('MAN-1 — segmento + manual: materializa la unión y devuelve el DTO curado (201)', async () => {
    const { app, campaignRepo } = buildApp({
      segmentCandidates: [makeCandidate({ clientId: 'c1', phone: '3364111111' })],
      manualCandidates: [makeCandidate({ clientId: 'm1', phone: '3364999999' })],
    });

    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'Segmento + manual',
      templateRef: 'HXapproved',
      segment: { statuses: ['late'] },
      manualClientIds: ['m1'],
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.total).toBe(2);
    // DTO curado — no la entidad Prisma cruda:
    expect(Object.keys(res.body).sort()).toEqual(['campaignId', 'status', 'total']);

    const recipients = await campaignRepo.listRecipients(res.body.campaignId);
    expect(recipients.data.map((r) => r.clientId).sort()).toEqual(['c1', 'm1']);
  });

  it('MAN-1 — solo lista manual (segmento sin criterio) → 201, materializa los manuales', async () => {
    const { app, campaignRepo } = buildApp({
      segmentCandidates: [],
      manualCandidates: [
        makeCandidate({ clientId: 'm1', phone: '3364999991' }),
        makeCandidate({ clientId: 'm2', phone: '3364999992' }),
      ],
    });

    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'Solo manual',
      templateRef: 'HXapproved',
      segment: { statuses: [] },
      manualClientIds: ['m1', 'm2'],
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });

    expect(res.status).toBe(201);
    expect(res.body.total).toBe(2);
    const recipients = await campaignRepo.listRecipients(res.body.campaignId);
    expect(recipients.data.map((r) => r.clientId).sort()).toEqual(['m1', 'm2']);
  });

  it('MAN-3 — manualClientId inexistente → 422 MANUAL_RECIPIENTS_NOT_FOUND con missingClientIds, no crea Campaign', async () => {
    const { app, campaignRepo } = buildApp({ segmentCandidates: [], manualCandidates: [] });

    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x',
      templateRef: 'HXapproved',
      segment: { statuses: [] },
      manualClientIds: ['no-existe'],
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MANUAL_RECIPIENTS_NOT_FOUND');
    expect(res.body.missingClientIds).toEqual(['no-existe']);
    const list = await campaignRepo.list({ page: 1, limit: 10 });
    expect(list.total).toBe(0);
  });

  it('MAN-5 — POST /segment/preview con manualClientIds → count refleja la unión sin doble-contar', async () => {
    const { app } = buildApp({
      segmentCandidates: [
        makeCandidate({ clientId: 'c1', phone: '3364111111' }),
        makeCandidate({ clientId: 'c2', phone: '3364222222' }),
      ],
      manualCandidates: [
        makeCandidate({ clientId: 'c2', phone: '3364222222' }), // overlap
        makeCandidate({ clientId: 'c3', phone: '3364333333' }),
      ],
    });

    const res = await request(app)
      .post('/api/messaging/bulk/segment/preview')
      .send({ statuses: ['late'], manualClientIds: ['c2', 'c3'] });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
  });
});

// ─── FIX-16: GET /segment/preview (query-params) ────────────────────────────────
describe('/api/messaging/bulk — GET /segment/preview (FIX-16)', () => {
  it('GET ?statuses=late&statuses=blocked&balanceMin → 200 count; mapea query→DTO', async () => {
    const { app, segmentSource } = buildApp({
      segmentCandidates: [makeCandidate({ clientId: 'c1', phone: '3364111111', balanceDue: 5000 })],
    });

    const res = await request(app)
      .get('/api/messaging/bulk/segment/preview')
      .query({ statuses: ['late', 'blocked'], balanceMin: '1000' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(segmentSource.listSegmentRecipients).toHaveBeenCalledWith({
      statuses: ['late', 'blocked'],
      balanceMin: 1000,
      balanceMax: undefined,
    });
  });
});

// ─── messaging-bulk v1.1 — POST/GET /segment/recipients (preview modal paginado) ──
describe('/api/messaging/bulk — POST /segment/recipients (v1.1)', () => {
  it('200 con {data,total,page,limit,skipped,statusCounts}; mapea statuses[]+balance+page+limit del body', async () => {
    const { app, segmentSource } = buildApp({
      segmentCandidates: [
        makeCandidate({ clientId: 'c1', phone: '3364111111', balanceDue: 5000 }),
        makeCandidate({ clientId: 'c2', phone: '3364222222', balanceDue: 8000 }),
      ],
    });

    const res = await request(app)
      .post('/api/messaging/bulk/segment/recipients')
      .send({ statuses: ['late', 'blocked'], balanceMin: 1000, balanceMax: 100000, page: 1, limit: 10 });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(10);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toHaveProperty('clientId');
    expect(res.body.data[0]).toHaveProperty('status');
    expect(res.body.skipped).toEqual({ optedOut: 0, duplicatePhone: 0, invalidPhone: 0 });
    expect(segmentSource.listSegmentRecipients).toHaveBeenCalledWith({
      statuses: ['late', 'blocked'],
      balanceMin: 1000,
      balanceMax: 100000,
    });
  });

  it('default page/limit cuando no vienen en el body', async () => {
    const { app } = buildApp({ segmentCandidates: [makeCandidate({ clientId: 'c1' })] });

    const res = await request(app).post('/api/messaging/bulk/segment/recipients').send({ statuses: ['late'] });

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(25);
  });
});

describe('/api/messaging/bulk — GET /segment/recipients (v1.1, deep-link)', () => {
  it('200; mapea query (?statuses=&page=&limit=) al mismo use case', async () => {
    const { app, segmentSource } = buildApp({
      segmentCandidates: [makeCandidate({ clientId: 'c1', phone: '3364111111', balanceDue: 5000 })],
    });

    const res = await request(app)
      .get('/api/messaging/bulk/segment/recipients')
      .query({ statuses: ['late', 'blocked'], balanceMin: '1000', page: '1', limit: '5' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(5);
    expect(segmentSource.listSegmentRecipients).toHaveBeenCalledWith({
      statuses: ['late', 'blocked'],
      balanceMin: 1000,
      balanceMax: undefined,
    });
  });
});

// ─── FIX-8: segmento sin criterio (apuntaría a TODA la base) → 400 end-to-end ────
describe('/api/messaging/bulk — FIX-8 (segmento sin criterio → 400)', () => {
  it('POST /campaigns SIN segment → 400 UNFILTERED_SEGMENT, no crea Campaign', async () => {
    const { app, campaignRepo } = buildApp();
    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x',
      templateRef: 'HXapproved',
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
      // sin `segment` — el route NO debe defaultear a "todos"
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNFILTERED_SEGMENT');
    const list = await campaignRepo.list({ page: 1, limit: 10 });
    expect(list.total).toBe(0);
  });

  it('POST /segment/preview con {statuses:[]} sin balance → 400 UNFILTERED_SEGMENT', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/messaging/bulk/segment/preview').send({ statuses: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNFILTERED_SEGMENT');
  });

  it('GET /segment/preview sin params → 400 UNFILTERED_SEGMENT', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/bulk/segment/preview');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNFILTERED_SEGMENT');
  });

  it('POST /segment/recipients con {statuses:[]} sin balance → 400 UNFILTERED_SEGMENT', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/messaging/bulk/segment/recipients').send({ statuses: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNFILTERED_SEGMENT');
  });

  it('GET /segment/recipients sin params → 400 UNFILTERED_SEGMENT', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/bulk/segment/recipients');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNFILTERED_SEGMENT');
  });
});

// ─── FIX-15: 409 con mensaje que refleja el lock GLOBAL (una campaña a la vez) ───
describe('/api/messaging/bulk — POST /campaigns/:id/send con lock GLOBAL tomado (FIX-15)', () => {
  it('otra corrida en curso (lock tomado) → 409 CAMPAIGN_SEND_IN_PROGRESS con mensaje "una campaña a la vez"', async () => {
    const { app, campaignRepo, lock } = buildApp();
    // simula un envío YA en curso: el lock GLOBAL está tomado por otra corrida.
    await lock.tryAcquire(CAMPAIGN_LOCK_KEY);
    const campaign = await campaignRepo.create({
      name: 'nueva', templateRef: 'HXapproved', segment: { statuses: ['late'] }, variableSpec: {}, total: 1, createdById: 'u',
    });

    const res = await request(app).post(`/api/messaging/bulk/campaigns/${campaign.id}/send`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CAMPAIGN_SEND_IN_PROGRESS');
    expect(res.body.error).toMatch(/una campaña a la vez/i);
  });
});

// ─── FIX-3: cota superior de manualClientIds → 422 end-to-end (no 500) ──────────
describe('/api/messaging/bulk — POST /campaigns con manualClientIds > cota (FIX-3)', () => {
  it('MAX+1 ids → 422 TOO_MANY_MANUAL_RECIPIENTS (rechazo limpio, no 500), no crea Campaign', async () => {
    const { app, campaignRepo } = buildApp();
    const ids = Array.from({ length: MAX_MANUAL_RECIPIENTS + 1 }, (_, i) => `c${i}`);

    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: ['late'] },
      manualClientIds: ids,
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TOO_MANY_MANUAL_RECIPIENTS');
    const list = await campaignRepo.list({ page: 1, limit: 10 });
    expect(list.total).toBe(0);
  });
});

// ─── FIX-4: manualClientIds fail-loud (no descartar no-strings en silencio) ──────
describe('/api/messaging/bulk — manualClientIds fail-loud (FIX-4)', () => {
  it('FIX-4 (a): manualClientIds con un elemento no-string (number) → 400, no crea Campaign', async () => {
    const { app, campaignRepo } = buildApp();
    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: ['late'] },
      manualClientIds: [123],
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const list = await campaignRepo.list({ page: 1, limit: 10 });
    expect(list.total).toBe(0);
  });

  it('FIX-4 (b): manualClientIds que NO es array (string) → 400', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: ['late'] },
      manualClientIds: 'abc',
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('FIX-4 (b bis): POST /segment/preview con manualClientIds no-array → 400 (mismo guard compartido)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/messaging/bulk/segment/preview')
      .send({ statuses: ['late'], manualClientIds: { nope: true } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('FIX-4 (c): sin manualClientIds → sigue OK (campaña solo-segmento, 201)', async () => {
    const { app } = buildApp({ segmentCandidates: [makeCandidate({ clientId: 'c1', phone: '3364111111' })] });
    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: ['late'] },
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(1);
  });

  it('FIX-4 (d): manualClientIds con whitespace se limpia (trim); el id real entra', async () => {
    const { app, campaignRepo } = buildApp({
      segmentCandidates: [makeCandidate({ clientId: 's1', phone: '3364000001' })],
      manualCandidates: [makeCandidate({ clientId: 'c1', phone: '3364999999' })],
    });
    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: ['late'] },
      manualClientIds: ['  ', 'c1'],
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });
    expect(res.status).toBe(201);
    const recipients = await campaignRepo.listRecipients(res.body.campaignId);
    expect(recipients.data.map((r) => r.clientId).sort()).toEqual(['c1', 's1']);
  });
});

// ─── bulk-csv-recipients (CSV-1..CSV-6, DET-1..DET-3): 4to dominio vía HTTP ────
describe('/api/messaging/bulk — bulk-csv-recipients (manualContacts)', () => {
  it('CSV-5 (a): manualContacts malformado (phone no-string) → 400 VALIDATION_ERROR, no crea Campaign', async () => {
    const { app, campaignRepo } = buildApp();
    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: ['late'] },
      manualContacts: [{ name: 'Ana', phone: 123 }],
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const list = await campaignRepo.list({ page: 1, limit: 10 });
    expect(list.total).toBe(0);
  });

  it('CSV-5 (b): manualContacts que NO es array → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: ['late'] },
      manualContacts: 'abc',
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('CSV-5 (b bis): POST /segment/preview con manualContacts malformado → 400 (mismo guard compartido)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/messaging/bulk/segment/preview')
      .send({ statuses: ['late'], manualContacts: [{ name: 'Ana' }] }); // sin phone
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('CSV-5 (c): manualContacts NORMALIZADO > MAX_MANUAL_CONTACTS → 422 TOO_MANY_MANUAL_CONTACTS, no crea Campaign', async () => {
    const { app, campaignRepo } = buildApp();
    const contacts = Array.from({ length: MAX_MANUAL_CONTACTS + 1 }, (_, i) => ({ name: `n${i}`, phone: `n${i}` }));
    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: ['late'] },
      manualContacts: contacts,
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TOO_MANY_MANUAL_CONTACTS');
    const list = await campaignRepo.list({ page: 1, limit: 10 });
    expect(list.total).toBe(0);
  });

  it('CSV-1 — POST /campaigns solo-CSV (segmento sin criterio) → 201, materializa los contactos crudos', async () => {
    const { app, campaignRepo } = buildApp({ segmentCandidates: [] });
    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'Solo CSV',
      templateRef: 'HXapproved',
      segment: { statuses: [] },
      manualContacts: [
        { name: 'Ana', phone: '11 2345-6789' },
        { name: 'Beto', phone: '011 15-3456-7890' },
      ],
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });

    expect(res.status).toBe(201);
    expect(res.body.total).toBe(2);
    const recipients = await campaignRepo.listRecipients(res.body.campaignId);
    expect(recipients.data.every((r) => r.clientId === null)).toBe(true);
  });

  it("view:'excluded' en POST /segment/recipients → 200 con el detalle por-persona paginado", async () => {
    const { app } = buildApp({ segmentCandidates: [] });
    const res = await request(app)
      .post('/api/messaging/bulk/segment/recipients')
      .send({
        statuses: [],
        manualContacts: [
          { name: '', phone: '3364999999' }, // sin_nombre
          { name: 'Beto', phone: 'no-es-numero' }, // telefono_invalido
        ],
        view: 'excluded',
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toHaveProperty('reason');
    expect(res.body.data[0]).toHaveProperty('name');
    expect(res.body.data[0]).toHaveProperty('phone');
    expect(res.body.total).toBe(2);
  });

  it("view por defecto ('recipients') en POST /segment/recipients con manualContacts — items traen source:'csv'", async () => {
    const { app } = buildApp({ segmentCandidates: [] });
    const res = await request(app)
      .post('/api/messaging/bulk/segment/recipients')
      .send({ statuses: [], manualContacts: [{ name: 'Ana', phone: '11 2345-6789' }] });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ clientId: null, source: 'csv', status: 'no_cliente' });
  });

  it('DET-1: solo-manual en POST /segment/recipients ya NO es 400 (cierra la deuda F4)', async () => {
    const { app } = buildApp({ segmentCandidates: [], manualCandidates: [makeCandidate({ clientId: 'm1', phone: '3364999999' })] });
    const res = await request(app)
      .post('/api/messaging/bulk/segment/recipients')
      .send({ statuses: [], manualClientIds: ['m1'] });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({ clientId: 'm1', source: 'manual' });
  });

  it('GET /segment/recipients?view=excluded conserva el segmento por query (DET-3, sin manualContacts)', async () => {
    const { app } = buildApp({ segmentCandidates: [makeCandidate({ clientId: 'c1', phone: '123' })] }); // teléfono inválido
    const res = await request(app)
      .get('/api/messaging/bulk/segment/recipients')
      .query({ statuses: 'late', view: 'excluded' });

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ reason: 'telefono_invalido', source: 'segment' });
  });
});

// ─── node-segment — filtro nodo/AP por las rutas (Zod + wiring al port) ─────────

describe('/api/messaging/bulk — node-segment (networkSiteId/accessPointId)', () => {
  it('POST /segment/preview con networkSiteId SOLO (sin statuses) → 200 y el filtro llega al port', async () => {
    const { app, segmentSource } = buildApp({
      segmentCandidates: [makeCandidate({ clientId: 'c1', phone: '3364111111' })],
    });

    const res = await request(app)
      .post('/api/messaging/bulk/segment/preview')
      .send({ statuses: [], networkSiteId: 'ns-1' });

    expect(res.status).toBe(200); // nodo solo ES segmento válido (no UNFILTERED_SEGMENT)
    expect(res.body.count).toBe(1);
    expect(segmentSource.listSegmentRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ networkSiteId: 'ns-1' }),
    );
  });

  it('POST /segment/preview con accessPointId (sin nodo) → 200 y el filtro llega al port', async () => {
    const { app, segmentSource } = buildApp({
      segmentCandidates: [makeCandidate({ clientId: 'c1', phone: '3364111111' })],
    });

    const res = await request(app)
      .post('/api/messaging/bulk/segment/preview')
      .send({ statuses: [], accessPointId: 'ap-9' });

    expect(res.status).toBe(200);
    expect(segmentSource.listSegmentRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ accessPointId: 'ap-9' }),
    );
  });

  it('POST /segment/preview con networkSiteId NO-string (number) → 400 VALIDATION_ERROR, sin tocar la fuente', async () => {
    const { app, segmentSource } = buildApp();

    const res = await request(app)
      .post('/api/messaging/bulk/segment/preview')
      .send({ statuses: ['late'], networkSiteId: 123 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(segmentSource.listSegmentRecipients).not.toHaveBeenCalled();
  });

  it('POST /segment/preview con accessPointId NO-string (objeto) → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/messaging/bulk/segment/preview')
      .send({ statuses: ['late'], accessPointId: { id: 'ap-9' } });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('POST /segment/preview con null explícito → 200 (null = sin filtro, backcompat)', async () => {
    const { app, segmentSource } = buildApp({
      segmentCandidates: [makeCandidate({ clientId: 'c1', phone: '3364111111' })],
    });

    const res = await request(app)
      .post('/api/messaging/bulk/segment/preview')
      .send({ statuses: ['late'], networkSiteId: null, accessPointId: null });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(segmentSource.listSegmentRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ['late'] }),
    );
  });

  it('GET /segment/preview?networkSiteId=ns-1 → 200 y el filtro llega al port (query escalar)', async () => {
    const { app, segmentSource } = buildApp({
      segmentCandidates: [makeCandidate({ clientId: 'c1', phone: '3364111111' })],
    });

    const res = await request(app)
      .get('/api/messaging/bulk/segment/preview')
      .query({ networkSiteId: 'ns-1' });

    expect(res.status).toBe(200);
    expect(segmentSource.listSegmentRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ networkSiteId: 'ns-1' }),
    );
  });

  it('POST /segment/recipients con nodo+AP → 200, el port recibe AMBOS (la tabla del modal honra el filtro)', async () => {
    const { app, segmentSource } = buildApp({
      segmentCandidates: [makeCandidate({ clientId: 'c1', phone: '3364111111' })],
    });

    const res = await request(app)
      .post('/api/messaging/bulk/segment/recipients')
      .send({ statuses: [], networkSiteId: 'ns-1', accessPointId: 'ap-2' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(segmentSource.listSegmentRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ networkSiteId: 'ns-1', accessPointId: 'ap-2' }),
    );
  });

  it('POST /segment/recipients con networkSiteId NO-string → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/messaging/bulk/segment/recipients')
      .send({ statuses: ['late'], networkSiteId: 42 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('GET /segment/recipients?accessPointId=ap-9 → 200 y el filtro llega al port', async () => {
    const { app, segmentSource } = buildApp({
      segmentCandidates: [makeCandidate({ clientId: 'c1', phone: '3364111111' })],
    });

    const res = await request(app)
      .get('/api/messaging/bulk/segment/recipients')
      .query({ accessPointId: 'ap-9' });

    expect(res.status).toBe(200);
    expect(segmentSource.listSegmentRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ accessPointId: 'ap-9' }),
    );
  });

  it('POST /campaigns con segment.networkSiteId/accessPointId → 201 y el SNAPSHOT persiste ambos', async () => {
    const { app, campaignRepo, segmentSource } = buildApp({
      segmentCandidates: [makeCandidate({ clientId: 'c1', phone: '3364111111' })],
    });

    const res = await request(app)
      .post('/api/messaging/bulk/campaigns')
      .send({
        name: 'Corte nodo ns-1',
        templateRef: 'HXapproved',
        segment: { statuses: [], networkSiteId: 'ns-1', accessPointId: 'ap-1' },
        variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
      });

    expect(res.status).toBe(201);
    const persisted = await campaignRepo.findById(res.body.campaignId);
    expect(persisted?.segment.networkSiteId).toBe('ns-1');
    expect(persisted?.segment.accessPointId).toBe('ap-1');
    expect(segmentSource.listSegmentRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ networkSiteId: 'ns-1', accessPointId: 'ap-1' }),
    );
  });

  it('POST /campaigns con segment.networkSiteId NO-string → 400 VALIDATION_ERROR, NO se crea campaña', async () => {
    const { app, campaignRepo } = buildApp();

    const res = await request(app)
      .post('/api/messaging/bulk/campaigns')
      .send({
        name: 'inválida',
        templateRef: 'HXapproved',
        segment: { statuses: ['late'], networkSiteId: 42 },
        variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const list = await campaignRepo.list({});
    expect(list.total).toBe(0);
  });
});

// ─── bulk-granular-perms — gate por estado de cliente + números crudos ──────────
describe('/api/messaging/bulk — bulk-granular-perms (BLOQUEO por estado/tipo)', () => {
  it('POST /campaigns con destinatario blocked y usuario SIN bulk_blocked → 403 BULK_RECIPIENTS_NOT_PERMITTED con forbidden, NO crea campaña', async () => {
    const { app, campaignRepo } = buildApp({
      bulkActions: ['bulk'], // acceso, pero SIN bulk_blocked
      segmentCandidates: [makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'blocked' })],
    });

    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'aviso corte', templateRef: 'HXapproved', segment: { statuses: ['blocked'] },
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('BULK_RECIPIENTS_NOT_PERMITTED');
    expect(res.body.forbidden).toEqual(['blocked']);
    const list = await campaignRepo.list({ page: 1, limit: 10 });
    expect(list.total).toBe(0);
  });

  it('POST /campaigns con destinatario blocked y usuario CON bulk_blocked → 201', async () => {
    const { app } = buildApp({
      bulkActions: ['bulk', 'bulk_blocked'],
      segmentCandidates: [makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'blocked' })],
    });

    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'aviso corte', templateRef: 'HXapproved', segment: { statuses: ['blocked'] },
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });

    expect(res.status).toBe(201);
    expect(res.body.total).toBe(1);
  });

  it('POST /campaigns super_admin (resolver → ["*"]) con blocked → 201 (bypass total)', async () => {
    const { app } = buildApp({
      bulkActions: ['*'],
      segmentCandidates: [makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'blocked' })],
    });

    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: ['blocked'] },
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });

    expect(res.status).toBe(201);
  });

  it('POST /campaigns solo-números (manualContacts) SIN bulk_numbers → 403 forbidden ["números"]', async () => {
    const { app, campaignRepo } = buildApp({ bulkActions: ['bulk'], segmentCandidates: [] });

    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x', templateRef: 'HXapproved', segment: { statuses: [] },
      manualContacts: [{ name: 'Ana', phone: '11 2345-6789' }],
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('BULK_RECIPIENTS_NOT_PERMITTED');
    expect(res.body.forbidden).toEqual(['números']);
    const list = await campaignRepo.list({ page: 1, limit: 10 });
    expect(list.total).toBe(0);
  });

  it('POST /campaigns/:id/send: campaña con estado blocked, sender SIN bulk_blocked → 403 (re-chequeo en send)', async () => {
    const { app, campaignRepo } = buildApp({ bulkActions: ['bulk'] });
    // campaña YA creada (por alguien con permiso) con el snapshot de estados.
    const campaign = await campaignRepo.create({
      name: 'creada por un admin', templateRef: 'HXapproved', segment: { statuses: ['blocked'] },
      variableSpec: {}, total: 1, createdById: 'admin', recipientStatuses: ['blocked'], hasRawRecipients: false,
    });

    const res = await request(app).post(`/api/messaging/bulk/campaigns/${campaign.id}/send`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('BULK_RECIPIENTS_NOT_PERMITTED');
    expect(res.body.forbidden).toEqual(['blocked']);
    const fresh = await campaignRepo.findById(campaign.id);
    expect(fresh?.status).toBe('pending'); // no se disparó el envío
  });

  it('POST /campaigns/:id/send: mismo snapshot, sender CON bulk_blocked → 202 (envío aceptado)', async () => {
    const { app, campaignRepo } = buildApp({ bulkActions: ['bulk', 'bulk_blocked'] });
    const campaign = await campaignRepo.create({
      name: 'creada por un admin', templateRef: 'HXapproved', segment: { statuses: ['blocked'] },
      variableSpec: {}, total: 1, createdById: 'admin', recipientStatuses: ['blocked'], hasRawRecipients: false,
    });

    const res = await request(app).post(`/api/messaging/bulk/campaigns/${campaign.id}/send`);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ campaignId: campaign.id, accepted: true });
  });

  it('POST /campaigns/:id/send: F1 campaña pre-migración (snapshot vacío) + total>0 + sender NO-super-admin → 403 fail-closed (no BYPASS)', async () => {
    const { app, campaignRepo } = buildApp({ bulkActions: ['bulk'] });
    // campaña con el DEFAULT del snapshot (como una creada ANTES de la migración) PERO con destinatarios.
    const campaign = await campaignRepo.create({
      name: 'vieja', templateRef: 'HXapproved', segment: { statuses: ['late'] },
      variableSpec: {}, total: 3, createdById: 'admin', recipientStatuses: [], hasRawRecipients: false,
    });

    const res = await request(app).post(`/api/messaging/bulk/campaigns/${campaign.id}/send`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('BULK_RECIPIENTS_NOT_PERMITTED');
    expect(res.body.forbidden).toEqual(['desconocido']);
    const fresh = await campaignRepo.findById(campaign.id);
    expect(fresh?.status).toBe('pending'); // no se disparó el envío
  });

  it('POST /campaigns/:id/send: MISMA campaña pre-migración + super_admin (["*"]) → 202 (envía)', async () => {
    const { app, campaignRepo } = buildApp({ bulkActions: ['*'] });
    const campaign = await campaignRepo.create({
      name: 'vieja', templateRef: 'HXapproved', segment: { statuses: ['late'] },
      variableSpec: {}, total: 3, createdById: 'admin', recipientStatuses: [], hasRawRecipients: false,
    });

    const res = await request(app).post(`/api/messaging/bulk/campaigns/${campaign.id}/send`);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ campaignId: campaign.id, accepted: true });
  });

  it('POST /campaigns persiste el snapshot recipientStatuses + hasRawRecipients de la unión', async () => {
    const { app, campaignRepo } = buildApp({
      bulkActions: ['*'],
      segmentCandidates: [
        makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'late' }),
        makeCandidate({ clientId: 'c2', phone: '3364222222', status: 'blocked' }),
      ],
    });

    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'mixta', templateRef: 'HXapproved', segment: { statuses: ['late', 'blocked'] },
      manualContacts: [{ name: 'Crudo', phone: '11 2345-6789' }],
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });

    expect(res.status).toBe(201);
    const persisted = await campaignRepo.findById(res.body.campaignId);
    expect(persisted?.recipientStatuses.sort()).toEqual(['blocked', 'late']);
    expect(persisted?.hasRawRecipients).toBe(true);
  });
});

// ─── bulk-task-recipients (B4.3/B4.4, TASK-1, D5) — wire de taskStageIds ─────────
// El use case (PreviewCampaignSegment/ListSegmentRecipients/CreateCampaign)
// TODAVÍA no consume `taskStageIds` (eso es B5.3) — estos tests pinean el
// PARSER fail-loud (`toTaskStageIds`) + que el valor parseado llegue INTACTO
// al input del use case, vía spy sobre `execute` (molde: no hay port
// observable acá, el consumo real es B5).
describe('/api/messaging/bulk — taskStageIds (B4, parser fail-loud + wire)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POST /segment/preview con taskStageIds:"no-es-array" → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/messaging/bulk/segment/preview')
      .send({ statuses: ['late'], taskStageIds: 'no-es-array' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('POST /segment/recipients con taskStageIds con un elemento no-string → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/messaging/bulk/segment/recipients')
      .send({ statuses: ['late'], taskStageIds: ['stageA', 123] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('POST /campaigns con taskStageIds malformado (objeto, no array) → 400 VALIDATION_ERROR, no crea Campaign', async () => {
    const { app, campaignRepo } = buildApp();
    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x',
      templateRef: 'HXapproved',
      segment: { statuses: ['late'] },
      taskStageIds: { foo: 'bar' },
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    const list = await campaignRepo.list({ page: 1, limit: 10 });
    expect(list.total).toBe(0);
  });

  it('taskStageIds AUSENTE → sigue siendo válido, no participa (no-regresión, TASK-1 escenario 1)', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/messaging/bulk/segment/preview').send({ statuses: ['late'] });
    expect(res.status).toBe(200);
  });

  it('POST /segment/preview con taskStageIds bien formado → llega INTACTO al input de PreviewCampaignSegment.execute', async () => {
    const { app } = buildApp();
    const executeSpy = jest.spyOn(PreviewCampaignSegment.prototype, 'execute');

    const res = await request(app)
      .post('/api/messaging/bulk/segment/preview')
      .send({ statuses: ['late'], taskStageIds: ['stageA', 'stageB'] });

    expect(res.status).toBe(200);
    expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ taskStageIds: ['stageA', 'stageB'] }));
  });

  it('GET /segment/preview?taskStageIds=stageA&taskStageIds=stageB parsea a un array (paridad de deep-link, D5)', async () => {
    const { app } = buildApp();
    const executeSpy = jest.spyOn(PreviewCampaignSegment.prototype, 'execute');

    const res = await request(app)
      .get('/api/messaging/bulk/segment/preview')
      .query({ statuses: ['late'], taskStageIds: ['stageA', 'stageB'] });

    expect(res.status).toBe(200);
    expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ taskStageIds: ['stageA', 'stageB'] }));
  });

  it('POST /segment/recipients con taskStageIds bien formado → llega INTACTO al input de ListSegmentRecipients.execute', async () => {
    const { app } = buildApp();
    const executeSpy = jest.spyOn(ListSegmentRecipients.prototype, 'execute');

    const res = await request(app)
      .post('/api/messaging/bulk/segment/recipients')
      .send({ statuses: ['late'], taskStageIds: ['stageA'] });

    expect(res.status).toBe(200);
    expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ taskStageIds: ['stageA'] }));
  });

  it('GET /segment/recipients?taskStageIds=stageA parsea a un array (paridad de deep-link, D5)', async () => {
    const { app } = buildApp();
    const executeSpy = jest.spyOn(ListSegmentRecipients.prototype, 'execute');

    const res = await request(app)
      .get('/api/messaging/bulk/segment/recipients')
      .query({ statuses: ['late'], taskStageIds: ['stageA'] });

    expect(res.status).toBe(200);
    expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ taskStageIds: ['stageA'] }));
  });

  it('POST /campaigns con taskStageIds bien formado → llega INTACTO al input de CreateCampaign.execute', async () => {
    const { app } = buildApp();
    const executeSpy = jest.spyOn(CreateCampaign.prototype, 'execute');

    const res = await request(app).post('/api/messaging/bulk/campaigns').send({
      name: 'x',
      templateRef: 'HXapproved',
      segment: { statuses: ['late'] },
      taskStageIds: ['stageA'],
      variablesMap: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
    });

    expect(res.status).toBe(201);
    expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ taskStageIds: ['stageA'] }));
  });
});
