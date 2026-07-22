/**
 * messaging-bulk (F2, T4.3, SEND-2..SEND-7) — `SendCampaign`. Executor molde
 * `RunBulkEnforcement.execute` (best-effort por-fila, progreso persistido,
 * resumible). Constructor `(campaignRepo, customerRepo, templatePort,
 * rateLimiter, backoffOpts?)`.
 *
 * `customerRepo` acá es `CampaignRecipientLookup` (T3.3-style: fake mínimo
 * inline, NO un `InMemoryCustomerRepository` completo — ver nota de gap en
 * `CreateCampaign.test.ts`/`PreviewCampaignSegment.test.ts`). Es un port
 * DISTINTO de `CampaignSegmentSource` (usado por Preview/Create): `SendCampaign`
 * solo necesita re-chequear UN candidato a la vez (SEND-5), no listar el
 * segmento completo — agregar el método a `CampaignSegmentSource` habría roto
 * los fakes ya verdes de Batch 3 (ver `CustomerRepository.ts`).
 *
 * Tests con el fake `InMemoryTemplateMessagingGateway` (T3.2) + `ImmediateRateLimiter`
 * (T4.1) salvo donde el escenario necesita control fino de reintentos/rate
 * limit — ahí se usa un `TemplateMessagingPort`/`RateLimiter` espía inline.
 */
import { SendCampaign, formatArs, resolveCampaignVariables } from '@application/use-cases/messaging/SendCampaign';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import { InMemoryTemplateMessagingGateway } from '@infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';
import { ImmediateRateLimiter } from '@infrastructure/adapters/in-memory/ImmediateRateLimiter';
import {
  TemplateProviderUnavailableError,
  TemplateSendRejectedError,
  TemplateProviderConfigError,
} from '@domain/errors/messaging-bulk';
import type { CampaignRecipientLookup, CampaignRecipientCandidate } from '@domain/ports/CustomerRepository';
import type { TemplateMessagingPort, SendTemplateResult } from '@domain/ports/TemplateMessagingPort';
import type { RateLimiter } from '@domain/ports/RateLimiter';
import type { CampaignVariableSpec, CampaignRecipient } from '@domain/entities/campaign';
import type {
  CampaignRepository,
  CampaignCreateData,
  CampaignPatch,
  CampaignRecipientCreateRow,
  CampaignRecipientPatch,
  ListCampaignsQuery,
  ListRecipientsFilter,
  ListRecipientsKeysetFilter,
} from '@domain/ports/CampaignRepository';
import { RESUME_PAGE_SIZE } from '@application/use-cases/messaging/SendCampaign';
import type { Campaign } from '@domain/entities/campaign';
import type { PaginatedResult } from '@application/dto/pagination';
// chatwoot-hub-sendpath (B4) — flag-aware: envío/proyección vía ChatwootGateway.
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { FakeChatwootGateway } from '../../helpers/FakeChatwootGateway';
import { FakeCampaignInboxProjector } from '../../helpers/FakeCampaignInboxProjector';
import type { TemplateDto } from '@domain/ports/TemplateMessagingPort';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';

/** PRNG determinística (mulberry32) — shuffle reproducible, sin flakiness en CI. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FIX-4 — repo que REPRODUCE la inestabilidad de orden de Postgres bajo empates
 * de `createdAt` (createMany escribe el MISMO `createdAt` a todos). En cada
 * `listRecipients` baraja (shuffle determinístico) el set completo ANTES de
 * paginar — modela "sin ORDER BY total, el orden es arbitrario y puede diferir
 * entre queries". Compone el `InMemoryCampaignRepository` real (misma data), solo
 * intercepta el orden de `listRecipients`. Un `drainQueue` que dependa del orden
 * (offset pagination con `page++`) puede saltear un recipient → nunca procesado.
 */
class UnstableOrderCampaignRepository implements CampaignRepository {
  private calls = 0;
  constructor(private readonly inner: InMemoryCampaignRepository) {}

  create(data: CampaignCreateData): Promise<Campaign> {
    return this.inner.create(data);
  }
  findById(id: string): Promise<Campaign | null> {
    return this.inner.findById(id);
  }
  update(id: string, patch: CampaignPatch): Promise<Campaign> {
    return this.inner.update(id, patch);
  }
  list(query: ListCampaignsQuery): Promise<PaginatedResult<Campaign>> {
    return this.inner.list(query);
  }
  bulkCreateRecipients(campaignId: string, rows: CampaignRecipientCreateRow[]): Promise<CampaignRecipient[]> {
    return this.inner.bulkCreateRecipients(campaignId, rows);
  }
  updateRecipient(id: string, patch: CampaignRecipientPatch): Promise<CampaignRecipient> {
    return this.inner.updateRecipient(id, patch);
  }

  async listRecipients(campaignId: string, filter?: ListRecipientsFilter): Promise<PaginatedResult<CampaignRecipient>> {
    const all = await this.inner.listRecipients(campaignId, {
      statusIn: filter?.statusIn,
      page: 1,
      limit: Number.MAX_SAFE_INTEGER,
    });
    const rng = mulberry32(0xc0ffee + this.calls++);
    const shuffled = [...all.data];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const page = filter?.page && filter.page > 0 ? filter.page : 1;
    const limit = filter?.limit && filter.limit > 0 ? filter.limit : 25;
    const start = (page - 1) * limit;
    return { data: shuffled.slice(start, start + limit), total: all.total, page, limit };
  }

  // El keyset garantiza orden total `[createdAt, id]` por CONTRATO — la
  // inestabilidad que modela esta clase aplica solo al `listRecipients` sin
  // ORDER BY, no al keyset (que siempre ordena). Se delega al inner estable.
  listRecipientsKeyset(campaignId: string, filter: ListRecipientsKeysetFilter): Promise<CampaignRecipient[]> {
    return this.inner.listRecipientsKeyset(campaignId, filter);
  }
}

/**
 * F9 (fix wave) — wrapper que ACOTA cada página keyset a `pageSize` filas (default 2), forzando
 * MÚLTIPLES batches con pocos recipients. Ejercita el flip del flag ENTRE batches usando el
 * mecanismo REAL de `drainQueue` (que lee el flag una vez por batch). Compone el
 * `InMemoryCampaignRepository` real; sólo intercepta el `limit` del keyset.
 */
class SmallKeysetCampaignRepository implements CampaignRepository {
  constructor(private readonly inner: InMemoryCampaignRepository, private readonly pageSize = 2) {}
  create(data: CampaignCreateData): Promise<Campaign> {
    return this.inner.create(data);
  }
  findById(id: string): Promise<Campaign | null> {
    return this.inner.findById(id);
  }
  update(id: string, patch: CampaignPatch): Promise<Campaign> {
    return this.inner.update(id, patch);
  }
  list(query: ListCampaignsQuery): Promise<PaginatedResult<Campaign>> {
    return this.inner.list(query);
  }
  bulkCreateRecipients(campaignId: string, rows: CampaignRecipientCreateRow[]): Promise<CampaignRecipient[]> {
    return this.inner.bulkCreateRecipients(campaignId, rows);
  }
  updateRecipient(id: string, patch: CampaignRecipientPatch): Promise<CampaignRecipient> {
    return this.inner.updateRecipient(id, patch);
  }
  listRecipients(campaignId: string, filter?: ListRecipientsFilter): Promise<PaginatedResult<CampaignRecipient>> {
    return this.inner.listRecipients(campaignId, filter);
  }
  listRecipientsKeyset(campaignId: string, filter: ListRecipientsKeysetFilter): Promise<CampaignRecipient[]> {
    return this.inner.listRecipientsKeyset(campaignId, { ...filter, limit: Math.min(filter.limit, this.pageSize) });
  }
}

/**
 * FIX-5 — repo que hace fallar el write de `updateRecipient({status:'sent'})`
 * (hipo de DB) las primeras `failSentTimes` veces. El resto de los writes pasan.
 * Modela: Twilio ACEPTA el envío pero el `sent` no se persiste.
 */
class FailingSentPersistRepository implements CampaignRepository {
  public sentWriteAttempts = 0;
  constructor(
    private readonly inner: InMemoryCampaignRepository,
    private readonly failSentTimes: number,
  ) {}

  create(data: CampaignCreateData): Promise<Campaign> {
    return this.inner.create(data);
  }
  findById(id: string): Promise<Campaign | null> {
    return this.inner.findById(id);
  }
  update(id: string, patch: CampaignPatch): Promise<Campaign> {
    return this.inner.update(id, patch);
  }
  list(query: ListCampaignsQuery): Promise<PaginatedResult<Campaign>> {
    return this.inner.list(query);
  }
  bulkCreateRecipients(campaignId: string, rows: CampaignRecipientCreateRow[]): Promise<CampaignRecipient[]> {
    return this.inner.bulkCreateRecipients(campaignId, rows);
  }
  listRecipients(campaignId: string, filter?: ListRecipientsFilter): Promise<PaginatedResult<CampaignRecipient>> {
    return this.inner.listRecipients(campaignId, filter);
  }
  listRecipientsKeyset(campaignId: string, filter: ListRecipientsKeysetFilter): Promise<CampaignRecipient[]> {
    return this.inner.listRecipientsKeyset(campaignId, filter);
  }

  async updateRecipient(id: string, patch: CampaignRecipientPatch): Promise<CampaignRecipient> {
    if (patch.status === 'sent') {
      this.sentWriteAttempts++;
      if (this.sentWriteAttempts <= this.failSentTimes) {
        throw new Error('DB hiccup: no se pudo persistir sent');
      }
    }
    return this.inner.updateRecipient(id, patch);
  }
}

/**
 * FIX-4-v2 — repo que registra el `limit` de cada `listRecipientsKeyset` para
 * probar que el drenaje pagina con batches ACOTADOS (nunca `total`, que en 50-100k
 * recipients volaría la memoria). Compone el InMemoryCampaignRepository real.
 */
class KeysetRecordingRepository implements CampaignRepository {
  public keysetLimits: number[] = [];
  constructor(private readonly inner: InMemoryCampaignRepository) {}

  create(data: CampaignCreateData): Promise<Campaign> {
    return this.inner.create(data);
  }
  findById(id: string): Promise<Campaign | null> {
    return this.inner.findById(id);
  }
  update(id: string, patch: CampaignPatch): Promise<Campaign> {
    return this.inner.update(id, patch);
  }
  list(query: ListCampaignsQuery): Promise<PaginatedResult<Campaign>> {
    return this.inner.list(query);
  }
  bulkCreateRecipients(campaignId: string, rows: CampaignRecipientCreateRow[]): Promise<CampaignRecipient[]> {
    return this.inner.bulkCreateRecipients(campaignId, rows);
  }
  updateRecipient(id: string, patch: CampaignRecipientPatch): Promise<CampaignRecipient> {
    return this.inner.updateRecipient(id, patch);
  }
  listRecipients(campaignId: string, filter?: ListRecipientsFilter): Promise<PaginatedResult<CampaignRecipient>> {
    return this.inner.listRecipients(campaignId, filter);
  }
  listRecipientsKeyset(campaignId: string, filter: ListRecipientsKeysetFilter): Promise<CampaignRecipient[]> {
    this.keysetLimits.push(filter.limit);
    return this.inner.listRecipientsKeyset(campaignId, filter);
  }
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

/** T3.3 — fake mínimo inline de `CampaignRecipientLookup` (NO CustomerRepository completo). */
function makeLookup(candidates: CampaignRecipientCandidate[]) {
  const byId = new Map(candidates.map((c) => [c.clientId, { ...c }]));
  return {
    findRecipientCandidate: jest.fn(async (clientId: string) => {
      const c = byId.get(clientId);
      return c ? { ...c } : null;
    }),
    setOptOut(clientId: string, at = new Date().toISOString()): void {
      const c = byId.get(clientId);
      if (c) byId.set(clientId, { ...c, whatsappOptOutAt: at });
    },
  } satisfies CampaignRecipientLookup & { setOptOut(clientId: string, at?: string): void };
}

async function seedCampaign(
  campaignRepo: CampaignRepository,
  opts: {
    templateRef?: string;
    // chatwoot-hub-sendpath (B4) — opcional, backcompat: los tests existentes no
    // lo pasan (queda `null`, `renderTemplateBody` resuelve `''`, sin cambios).
    templateBody?: string | null;
    // campaign-chatwoot-label (CLBL-6) — opcional, backcompat: ausente → `null`
    // (comportamiento actual intacto, sin enganche de labeling).
    chatwootLabel?: string | null;
    variableSpec?: CampaignVariableSpec;
    recipients: { clientId: string | null; contactName?: string | null; phoneNormalized: string; phoneE164: string }[];
  },
) {
  const campaign = await campaignRepo.create({
    name: 'Test campaign',
    templateRef: opts.templateRef ?? 'HXtest',
    templateBody: opts.templateBody ?? null,
    chatwootLabel: opts.chatwootLabel ?? null,
    segment: { statuses: ['late'] },
    variableSpec: opts.variableSpec ?? {},
    total: opts.recipients.length,
    createdById: 'user-1',
  });
  const recipients = await campaignRepo.bulkCreateRecipients(campaign.id, opts.recipients);
  return { campaign, recipients };
}

describe('SendCampaign', () => {
  it('SEND-2: batch con éxitos y un fallo aislado — 2 sent + 1 failed, campaña done (el fallo no la marca failed global)', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const candidates = [makeCandidate({ clientId: 'c1' }), makeCandidate({ clientId: 'c2' }), makeCandidate({ clientId: 'c3' })];
    const lookup = makeLookup(candidates);
    const templatePort = new InMemoryTemplateMessagingGateway({ rejectPhone: '+5493364000002' });
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter());

    const { campaign } = await seedCampaign(campaignRepo, {
      recipients: [
        { clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' },
        { clientId: 'c2', phoneNormalized: '3364000002', phoneE164: '+5493364000002' }, // rechazado
        { clientId: 'c3', phoneNormalized: '3364000003', phoneE164: '+5493364000003' },
      ],
    });

    const result = await uc.execute({ campaignId: campaign.id });

    expect(result.status).toBe('done');
    expect(result.sentCount).toBe(2);
    expect(result.failedCount).toBe(1);

    const recipients = await campaignRepo.listRecipients(campaign.id);
    const c2 = recipients.data.find((r) => r.clientId === 'c2')!;
    expect(c2.status).toBe('failed');
    expect(c2.error).toBeTruthy();
    const c1 = recipients.data.find((r) => r.clientId === 'c1')!;
    expect(c1.status).toBe('sent');
    expect(c1.sentAt).toBeTruthy();
    expect(c1.providerId).toBeTruthy();
  });

  it('SEND-2 (variables): resuelve variableSpec por-destinatario (name/balanceDue/literal) antes de enviar', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const candidates = [makeCandidate({ clientId: 'c1', name: 'Juan Pérez', balanceDue: 50000 })];
    const lookup = makeLookup(candidates);
    const templatePort = new InMemoryTemplateMessagingGateway();
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter());

    const { campaign } = await seedCampaign(campaignRepo, {
      variableSpec: {
        '1': { source: 'name' },
        '2': { source: 'balanceDue' },
        '3': { source: 'literal', value: 'fijo' },
      },
      recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
    });

    await uc.execute({ campaignId: campaign.id });

    expect(templatePort.calls).toHaveLength(1);
    // FIX-18 — `balanceDue` se formatea como ARS legible ($ + miles con punto), no cruda.
    expect(templatePort.calls[0].variables).toEqual({ '1': 'Juan Pérez', '2': '$50.000', '3': 'fijo' });
    expect(templatePort.calls[0].to).toBe('+5493364000001');
    expect(templatePort.calls[0].contentSid).toBe(campaign.templateRef);
  });

  it('SEND-3: falla transitoria (503×2) y luego éxito — termina sent (reintentos transparentes)', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const lookup = makeLookup([makeCandidate({ clientId: 'c1' })]);
    const sendTemplate = jest
      .fn()
      .mockRejectedValueOnce(new TemplateProviderUnavailableError('503'))
      .mockRejectedValueOnce(new TemplateProviderUnavailableError('503'))
      .mockResolvedValueOnce({ providerId: 'SM1', status: 'queued' } satisfies SendTemplateResult);
    const templatePort: TemplateMessagingPort = { listTemplates: jest.fn(), sendTemplate };
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter(), undefined, {
      sleep: async () => {},
      random: () => 0,
      maxRetries: 3,
    });

    const { campaign } = await seedCampaign(campaignRepo, {
      recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
    });

    const result = await uc.execute({ campaignId: campaign.id });

    expect(sendTemplate).toHaveBeenCalledTimes(3);
    expect(result.sentCount).toBe(1);
    expect(result.failedCount).toBe(0);
  });

  it('SEND-3: falla persistente (500×N) agota los reintentos → failed con el error del último intento; el resto sigue', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const lookup = makeLookup([makeCandidate({ clientId: 'c1' }), makeCandidate({ clientId: 'c2' })]);
    const sendTemplate = jest.fn(async (to: string) => {
      if (to === '+5493364000001') throw new TemplateProviderUnavailableError('500 persistente');
      return { providerId: 'SM-ok', status: 'queued' } satisfies SendTemplateResult;
    });
    const templatePort: TemplateMessagingPort = { listTemplates: jest.fn(), sendTemplate };
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter(), undefined, {
      sleep: async () => {},
      random: () => 0,
      maxRetries: 2,
    });

    const { campaign } = await seedCampaign(campaignRepo, {
      recipients: [
        { clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' },
        { clientId: 'c2', phoneNormalized: '3364000002', phoneE164: '+5493364000002' },
      ],
    });

    const result = await uc.execute({ campaignId: campaign.id });

    // c1: 1 intento inicial + 2 reintentos = 3 llamadas; c2: 1 sola (éxito) = 4 total
    expect(sendTemplate).toHaveBeenCalledTimes(4);
    expect(result.failedCount).toBe(1);
    expect(result.sentCount).toBe(1);

    const recipients = await campaignRepo.listRecipients(campaign.id);
    const c1 = recipients.data.find((r) => r.clientId === 'c1')!;
    expect(c1.status).toBe('failed');
    expect(c1.error).toContain('500 persistente');
  });

  it('SEND-3: error no-retryable (400) falla en el PRIMER intento sin agotar reintentos', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const lookup = makeLookup([makeCandidate({ clientId: 'c1' })]);
    const sendTemplate = jest.fn().mockRejectedValue(new TemplateSendRejectedError('400 content_sid inválido'));
    const templatePort: TemplateMessagingPort = { listTemplates: jest.fn(), sendTemplate };
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter(), undefined, {
      sleep: async () => {},
      maxRetries: 3,
    });

    const { campaign } = await seedCampaign(campaignRepo, {
      recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
    });

    const result = await uc.execute({ campaignId: campaign.id });

    expect(sendTemplate).toHaveBeenCalledTimes(1); // sin agotar los 3 reintentos configurados
    expect(result.failedCount).toBe(1);
  });

  it('SEND-4: el limiter es consultado exactamente 1 vez por recipient, ANTES del sendTemplate correspondiente', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const candidates = Array.from({ length: 5 }, (_, i) => makeCandidate({ clientId: `c${i + 1}` }));
    const lookup = makeLookup(candidates);
    const order: string[] = [];
    const rateLimiter: RateLimiter = { acquire: jest.fn(async () => { order.push('acquire'); }) };
    const sendTemplate = jest.fn(async () => {
      order.push('send');
      return { providerId: 'SM-ok', status: 'queued' } satisfies SendTemplateResult;
    });
    const templatePort: TemplateMessagingPort = { listTemplates: jest.fn(), sendTemplate };
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, rateLimiter);

    const { campaign } = await seedCampaign(campaignRepo, {
      recipients: candidates.map((c, i) => ({
        clientId: c.clientId,
        phoneNormalized: `336400000${i}`,
        phoneE164: `+549336400000${i}`,
      })),
    });

    await uc.execute({ campaignId: campaign.id });

    expect(rateLimiter.acquire).toHaveBeenCalledTimes(5);
    expect(sendTemplate).toHaveBeenCalledTimes(5);
    expect(order).toEqual(['acquire', 'send', 'acquire', 'send', 'acquire', 'send', 'acquire', 'send', 'acquire', 'send']);
  });

  it('SEND-4: el limiter frena (espera) para un recipient sin descartarlo — sigue procesándose, nunca failed/skipped por throttle', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const candidates = Array.from({ length: 5 }, (_, i) => makeCandidate({ clientId: `c${i + 1}` }));
    const lookup = makeLookup(candidates);
    let calls = 0;
    const rateLimiter: RateLimiter = {
      acquire: jest.fn(async () => {
        calls++;
        if (calls === 3) await new Promise((resolve) => setTimeout(resolve, 5)); // el limiter "frena" el 3ro
      }),
    };
    const templatePort = new InMemoryTemplateMessagingGateway();
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, rateLimiter);

    const { campaign } = await seedCampaign(campaignRepo, {
      recipients: candidates.map((c, i) => ({
        clientId: c.clientId,
        phoneNormalized: `336400000${i}`,
        phoneE164: `+549336400000${i}`,
      })),
    });

    const result = await uc.execute({ campaignId: campaign.id });

    expect(result.sentCount).toBe(5);
    expect(result.failedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
  });

  it('SEND-5: opt-out ocurre ENTRE el create y el send de ESE recipient → opted-out sin invocar sendTemplate', async () => {
    // Reloj monótono → createdAt DISTINTO/creciente por recipient, así el drenaje
    // keyset (orden total `[createdAt, id]`, FIX-4-v2) procesa c1 ANTES que c2 de
    // forma determinística. Sin esto, `createMany` empata createdAt y el desempate
    // por uuid randomiza el orden (igual que en prod), volviendo flaky el escenario
    // "c2 responde BAJA justo mientras se procesa c1".
    let tick = 0;
    const campaignRepo = new InMemoryCampaignRepository({ now: () => new Date(2026, 0, 1, 0, 0, 0, tick++) });
    const candidates = [makeCandidate({ clientId: 'c1' }), makeCandidate({ clientId: 'c2' }), makeCandidate({ clientId: 'c3' })];
    const lookup = makeLookup(candidates);
    const c1Phone = '+5493364000001';
    const templatePort: TemplateMessagingPort = {
      listTemplates: jest.fn(),
      sendTemplate: jest.fn(async (to: string) => {
        if (to === c1Phone) {
          // simula: el cliente c2 responde "BAJA" justo mientras se procesa c1
          lookup.setOptOut('c2');
        }
        return { providerId: `SM-${to}`, status: 'queued' } satisfies SendTemplateResult;
      }),
    };
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter());

    const { campaign } = await seedCampaign(campaignRepo, {
      recipients: [
        { clientId: 'c1', phoneNormalized: '3364000001', phoneE164: c1Phone },
        { clientId: 'c2', phoneNormalized: '3364000002', phoneE164: '+5493364000002' },
        { clientId: 'c3', phoneNormalized: '3364000003', phoneE164: '+5493364000003' },
      ],
    });

    const result = await uc.execute({ campaignId: campaign.id });

    expect(templatePort.sendTemplate).toHaveBeenCalledTimes(2); // c1 y c3, NUNCA c2
    expect(templatePort.sendTemplate).not.toHaveBeenCalledWith('+5493364000002', expect.anything(), expect.anything());
    expect(result.sentCount).toBe(2);
    expect(result.optedOutCount).toBe(1);
    expect(result.failedCount).toBe(0);

    const recipients = await campaignRepo.listRecipients(campaign.id);
    const c2 = recipients.data.find((r) => r.clientId === 'c2')!;
    expect(c2.status).toBe('opted_out');
  });

  it('SEND-6: resumible — 2 ya sent (corrida previa) + 3 queued → sendTemplate SOLO para los 3 queued', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const candidates = Array.from({ length: 5 }, (_, i) => makeCandidate({ clientId: `c${i + 1}` }));
    const lookup = makeLookup(candidates);
    const templatePort = new InMemoryTemplateMessagingGateway();
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter());

    const { campaign, recipients } = await seedCampaign(campaignRepo, {
      recipients: candidates.map((c, i) => ({
        clientId: c.clientId,
        phoneNormalized: `336400000${i}`,
        phoneE164: `+549336400000${i}`,
      })),
    });
    // simula una corrida previa interrumpida: c1/c2 ya sent
    await campaignRepo.updateRecipient(recipients[0].id, { status: 'sent', providerId: 'SM-old1', sentAt: '2026-01-01T00:00:00.000Z' });
    await campaignRepo.updateRecipient(recipients[1].id, { status: 'sent', providerId: 'SM-old2', sentAt: '2026-01-01T00:00:00.000Z' });

    const result = await uc.execute({ campaignId: campaign.id });

    expect(templatePort.calls).toHaveLength(3); // solo los 3 queued
    expect(result.sentCount).toBe(5); // los 2 previos + los 3 nuevos, conteo REAL

    // los ya-sent de la corrida previa NO se re-enviaron (sentAt/providerId intactos)
    const all = await campaignRepo.listRecipients(campaign.id);
    const r1 = all.data.find((r) => r.id === recipients[0].id)!;
    expect(r1.providerId).toBe('SM-old1');
    expect(r1.sentAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('SEND-7: campaña con 30 recipients (más que una página típica de 25) → contadores REALES, no truncados', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const candidates = Array.from({ length: 30 }, (_, i) => makeCandidate({ clientId: `c${i + 1}` }));
    const lookup = makeLookup(candidates);
    const templatePort = new InMemoryTemplateMessagingGateway();
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter());

    const { campaign } = await seedCampaign(campaignRepo, {
      recipients: candidates.map((c, i) => ({
        clientId: c.clientId,
        phoneNormalized: `33640${String(i).padStart(5, '0')}`,
        phoneE164: `+54933640${String(i).padStart(5, '0')}`,
      })),
    });

    const result = await uc.execute({ campaignId: campaign.id });

    expect(result.sentCount).toBe(30);
    expect(result.sentCount + result.failedCount + result.skippedCount + result.optedOutCount).toBe(result.total);
    expect(templatePort.calls).toHaveLength(30);
  });

  // ── FIX-2: error SISTÉMICO de config/auth aborta el run (no quema recipients) ──
  it('FIX-2: 401 sistémico (TemplateProviderConfigError) ABORTA el run — execute rechaza, recipients siguen queued (NO failed)', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const candidates = Array.from({ length: 4 }, (_, i) => makeCandidate({ clientId: `c${i + 1}` }));
    const lookup = makeLookup(candidates);
    // El proveedor está mal configurado (token rotado) → TODO envío tira config error.
    const sendTemplate = jest.fn(async () => {
      throw new TemplateProviderConfigError('Twilio 401 — proveedor mal configurado');
    });
    const templatePort: TemplateMessagingPort = { listTemplates: jest.fn(), sendTemplate };
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter(), undefined, {
      sleep: async () => {},
      maxRetries: 3,
    });

    const { campaign } = await seedCampaign(campaignRepo, {
      recipients: candidates.map((c, i) => ({
        clientId: c.clientId,
        phoneNormalized: `336400000${i}`,
        phoneE164: `+549336400000${i}`,
      })),
    });

    // Aborta: execute propaga el error de config (el CampaignRunner lo cataloga
    // como campaña `failed` con motivo claro — CampaignRunner.test.ts lo cubre).
    await expect(uc.execute({ campaignId: campaign.id })).rejects.toBeInstanceOf(TemplateProviderConfigError);

    // NINGÚN recipient quemado a `failed`: siguen `queued` (re-disparables tras fix de config).
    const recipients = await campaignRepo.listRecipients(campaign.id, { limit: 100 });
    expect(recipients.data.every((r) => r.status === 'queued')).toBe(true);
    expect(recipients.data.some((r) => r.status === 'failed')).toBe(false);
    // El envío se cortó al PRIMER recipient (no siguió quemando el lote).
    expect(sendTemplate).toHaveBeenCalledTimes(1);
  });

  it('FIX-2: un rechazo per-destinatario (número inválido, TemplateSendRejectedError) NO aborta — ese failed, el resto sigue', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const candidates = [makeCandidate({ clientId: 'c1' }), makeCandidate({ clientId: 'c2' }), makeCandidate({ clientId: 'c3' })];
    const lookup = makeLookup(candidates);
    const sendTemplate = jest.fn(async (to: string) => {
      if (to === '+5493364000002') throw new TemplateSendRejectedError('Twilio respondió con status 400 (code 21211)');
      return { providerId: `SM-${to}`, status: 'queued' } satisfies SendTemplateResult;
    });
    const templatePort: TemplateMessagingPort = { listTemplates: jest.fn(), sendTemplate };
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter());

    const { campaign } = await seedCampaign(campaignRepo, {
      recipients: [
        { clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' },
        { clientId: 'c2', phoneNormalized: '3364000002', phoneE164: '+5493364000002' }, // rechazado per-mensaje
        { clientId: 'c3', phoneNormalized: '3364000003', phoneE164: '+5493364000003' },
      ],
    });

    const result = await uc.execute({ campaignId: campaign.id });

    expect(result.status).toBe('done'); // NO abortó
    expect(result.sentCount).toBe(2);
    expect(result.failedCount).toBe(1);
    const recipients = await campaignRepo.listRecipients(campaign.id);
    expect(recipients.data.find((r) => r.clientId === 'c2')!.status).toBe('failed');
  });

  // ── FIX-4: drop silencioso por paginación inestable ────────────────────────
  it('FIX-4: 70 recipients con fallos intercalados + orden INESTABLE bajo empates → ninguno queda sin procesar (suma == total)', async () => {
    const inner = new InMemoryCampaignRepository();
    const campaignRepo = new UnstableOrderCampaignRepository(inner);
    const TOTAL = 70;
    const candidates = Array.from({ length: TOTAL }, (_, i) => makeCandidate({ clientId: `c${String(i).padStart(3, '0')}` }));
    const lookup = makeLookup(candidates);
    const phoneOf = (i: number) => `+54933640${String(i).padStart(5, '0')}`;
    // La MAYORÍA falla (per-destinatario) → esos quedan 'failed' y SIGUEN en el
    // filtro `['queued','failed']`, manteniéndolo por encima del tamaño de página
    // (25) y forzando el camino de offset-pagination (`page++`) que, bajo orden
    // inestable, salteaba recipients. Los `idx % 5 === 0` sí se envían (salen del
    // filtro) — fallos intercalados, no un all-fail degenerado.
    const sendTemplate = jest.fn(async (to: string) => {
      const idx = Array.from({ length: TOTAL }, (_, i) => i).find((i) => phoneOf(i) === to)!;
      if (idx % 5 !== 0) throw new TemplateSendRejectedError(`rechazado ${to}`);
      return { providerId: `SM-${to}`, status: 'queued' } satisfies SendTemplateResult;
    });
    const templatePort: TemplateMessagingPort = { listTemplates: jest.fn(), sendTemplate };
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter(), undefined, {
      sleep: async () => {},
      maxRetries: 0,
    });

    const { campaign } = await seedCampaign(campaignRepo, {
      recipients: candidates.map((c, i) => ({
        clientId: c.clientId,
        phoneNormalized: `33640${String(i).padStart(5, '0')}`,
        phoneE164: phoneOf(i),
      })),
    });

    const result = await uc.execute({ campaignId: campaign.id });

    // NINGÚN recipient queda 'queued' (sin procesar) pese al orden inestable.
    const all = await inner.listRecipients(campaign.id, { limit: 1000 });
    const stuckQueued = all.data.filter((r) => r.status === 'queued');
    expect(stuckQueued).toHaveLength(0);
    // SEND-7 — los contadores REALES suman el total (nada se cayó entre páginas).
    expect(result.sentCount + result.failedCount + result.skippedCount + result.optedOutCount).toBe(result.total);
    expect(result.total).toBe(TOTAL);
  });

  // ── FIX-4-v2: drenaje con memoria ACOTADA (keyset), no fetch-todo (OOM) ────
  it('FIX-4-v2: 60 recipients → drena con keyset en batches ACOTADOS (limit <= RESUME_PAGE_SIZE, nunca total)', async () => {
    const inner = new InMemoryCampaignRepository();
    const campaignRepo = new KeysetRecordingRepository(inner);
    const TOTAL = 60; // > RESUME_PAGE_SIZE (25) → fuerza múltiples batches
    const candidates = Array.from({ length: TOTAL }, (_, i) => makeCandidate({ clientId: `c${String(i).padStart(3, '0')}` }));
    const lookup = makeLookup(candidates);
    const templatePort = new InMemoryTemplateMessagingGateway();
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter());

    const { campaign } = await seedCampaign(campaignRepo, {
      recipients: candidates.map((c, i) => ({
        clientId: c.clientId,
        phoneNormalized: `33640${String(i).padStart(5, '0')}`,
        phoneE164: `+54933640${String(i).padStart(5, '0')}`,
      })),
    });

    const result = await uc.execute({ campaignId: campaign.id });

    // el drenaje USÓ keyset y paginó (varios batches), NO un solo fetch gigante.
    expect(campaignRepo.keysetLimits.length).toBeGreaterThan(1);
    // batches ACOTADOS: NINGÚN fetch pide el set entero (`limit = total` = OOM en 100k).
    const maxKeysetLimit = Math.max(...campaignRepo.keysetLimits);
    expect(maxKeysetLimit).toBeLessThanOrEqual(RESUME_PAGE_SIZE);
    expect(maxKeysetLimit).toBeLessThan(TOTAL);
    // …y sin dropear a nadie: cada recipient procesado exactamente una vez.
    expect(result.sentCount).toBe(TOTAL);
    expect(result.sentCount + result.failedCount + result.skippedCount + result.optedOutCount).toBe(result.total);
    expect(templatePort.calls).toHaveLength(TOTAL);
  });

  // ── FIX-5: hipo de DB al persistir 'sent' NO re-etiqueta como failed ───────
  it('FIX-5: sendTemplate OK pero el write de `sent` tira una vez → reintenta y queda `sent` (NUNCA failed/re-enviable)', async () => {
    const inner = new InMemoryCampaignRepository();
    const campaignRepo = new FailingSentPersistRepository(inner, 1); // falla el 1er write de 'sent'
    const lookup = makeLookup([makeCandidate({ clientId: 'c1' })]);
    const templatePort = new InMemoryTemplateMessagingGateway();
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter(), undefined, {
      sleep: async () => {},
    });

    const { campaign } = await seedCampaign(campaignRepo, {
      recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
    });

    const result = await uc.execute({ campaignId: campaign.id });

    expect(templatePort.calls).toHaveLength(1); // se envió UNA sola vez
    const recipient = (await inner.listRecipients(campaign.id)).data[0];
    expect(recipient.status).toBe('sent'); // reintento del persist funcionó
    expect(recipient.status).not.toBe('failed');
    expect(result.sentCount).toBe(1);
    expect(result.failedCount).toBe(0);
  });

  // ── FIX-18: balanceDue null/formato en las variables del template ──────────
  it('FIX-18: balanceDue con decimales → ARS legible ($12.345,50)', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const lookup = makeLookup([makeCandidate({ clientId: 'c1', balanceDue: 12345.5 })]);
    const templatePort = new InMemoryTemplateMessagingGateway();
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter());

    const { campaign } = await seedCampaign(campaignRepo, {
      variableSpec: { '1': { source: 'balanceDue' } },
      recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
    });

    await uc.execute({ campaignId: campaign.id });

    expect(templatePort.calls[0].variables['1']).toBe('$12.345,50');
  });

  it('FIX-18: balanceDue null (never-synced) → variable vacía, NUNCA "$0" espurio', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const lookup = makeLookup([makeCandidate({ clientId: 'c1', balanceDue: null })]);
    const templatePort = new InMemoryTemplateMessagingGateway();
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter());

    const { campaign } = await seedCampaign(campaignRepo, {
      variableSpec: { '1': { source: 'balanceDue' } },
      recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
    });

    await uc.execute({ campaignId: campaign.id });

    expect(templatePort.calls[0].variables['1']).toBe(''); // no "$0"
  });

  describe('FIX-18: formatArs (ARS legible, determinístico)', () => {
    it.each([
      [50000, '$50.000'],
      [12345.5, '$12.345,50'],
      [1000, '$1.000'],
      [999, '$999'],
      [0, '$0'],
      [1234567, '$1.234.567'],
      [100.9, '$100,90'],
    ])('formatArs(%p) === %p', (input, expected) => {
      expect(formatArs(input)).toBe(expected);
    });
  });

  it('FIX-5: si el persist de `sent` falla SIEMPRE → el recipient NO queda `failed` (un envío aceptado nunca es re-enviable acá)', async () => {
    const inner = new InMemoryCampaignRepository();
    const campaignRepo = new FailingSentPersistRepository(inner, Number.MAX_SAFE_INTEGER); // el 'sent' nunca persiste
    const lookup = makeLookup([makeCandidate({ clientId: 'c1' })]);
    const templatePort = new InMemoryTemplateMessagingGateway();
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter(), undefined, {
      sleep: async () => {},
    });

    const { campaign } = await seedCampaign(campaignRepo, {
      recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
    });

    await uc.execute({ campaignId: campaign.id });

    expect(templatePort.calls).toHaveLength(1); // no se re-envió en ESTA corrida
    const recipient = (await inner.listRecipients(campaign.id)).data[0];
    // Clave del fix: NUNCA convertir un envío ACEPTADO en `failed` (sería resumible → re-envío).
    expect(recipient.status).not.toBe('failed');
  });

  // ── bulk-csv-recipients (D5, CSV-3): recipient crudo (clientId null) ──────────
  describe('bulk-csv-recipients (D5/CSV-3): contacto crudo (clientId null)', () => {
    it('crudo: NO llama findRecipientCandidate, variables {name: contactName, balanceDue: \'\'}, queda sent', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([]); // universo vacío — si lo llamara, no resolvería nada
      const templatePort = new InMemoryTemplateMessagingGateway();
      const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter());

      const { campaign } = await seedCampaign(campaignRepo, {
        variableSpec: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
        recipients: [
          { clientId: null, contactName: 'Ana', phoneNormalized: '3364111111', phoneE164: '+5493364111111' },
        ],
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(lookup.findRecipientCandidate).not.toHaveBeenCalled();
      expect(result.sentCount).toBe(1);
      expect(templatePort.calls[0].variables).toEqual({ '1': 'Ana', '2': '' }); // NUNCA "$0"
      const recipient = (await campaignRepo.listRecipients(campaign.id)).data[0]!;
      expect(recipient.status).toBe('sent');
      expect(recipient.providerId).toBeTruthy();
    });

    it('crudo sin contactName (defensivo, nunca debería pasar) → name resuelve a cadena vacía, no revienta', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([]);
      const templatePort = new InMemoryTemplateMessagingGateway();
      const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter());

      const { campaign } = await seedCampaign(campaignRepo, {
        variableSpec: { '1': { source: 'name' } },
        recipients: [{ clientId: null, contactName: null, phoneNormalized: '3364111111', phoneE164: '+5493364111111' }],
      });

      await uc.execute({ campaignId: campaign.id });

      expect(templatePort.calls[0].variables['1']).toBe('');
    });

    it('vinculado sigue con re-check SEND-5 intacto (no-regresión): opt-out POST-create → opted_out, sin llamar sendTemplate', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([makeCandidate({ clientId: 'c1' })]);
      lookup.setOptOut('c1'); // opt-out DESPUÉS de "crear" (el candidate del lookup ya lo refleja)
      const templatePort = new InMemoryTemplateMessagingGateway();
      const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter());

      const { campaign } = await seedCampaign(campaignRepo, {
        recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(lookup.findRecipientCandidate).toHaveBeenCalledWith('c1');
      expect(templatePort.calls).toHaveLength(0);
      const recipient = (await campaignRepo.listRecipients(campaign.id)).data[0]!;
      expect(recipient.status).toBe('opted_out');
      void result;
    });

    it('mixto: batch con 1 vinculado + 1 crudo → ambos quedan sent, cada uno con sus variables correctas', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([makeCandidate({ clientId: 'c1', name: 'Cliente Real', balanceDue: 5000 })]);
      const templatePort = new InMemoryTemplateMessagingGateway();
      const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter());

      const { campaign } = await seedCampaign(campaignRepo, {
        variableSpec: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
        recipients: [
          { clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' },
          { clientId: null, contactName: 'Contacto CSV', phoneNormalized: '3364222222', phoneE164: '+5493364222222' },
        ],
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.sentCount).toBe(2);
      const byTo = new Map(templatePort.calls.map((c) => [c.to, c.variables]));
      expect(byTo.get('+5493364000001')).toEqual({ '1': 'Cliente Real', '2': '$5.000' });
      expect(byTo.get('+5493364222222')).toEqual({ '1': 'Contacto CSV', '2': '' });
    });
  });

  // ── var-fallback: fallback POR VARIABLE para destinatarios SIN cliente ───────
  // El fallback SOLO aplica a un candidate CRUDO (status 'no_cliente' — el que
  // SendCampaign sintetiza para un recipient `clientId: null`, D5). Un vinculado
  // (status ≠ 'no_cliente') SIEMPRE usa su dato real e IGNORA el fallback. El
  // fallback GANA sobre el nombre tipeado del crudo cuando está seteado (NO vacío).
  describe('var-fallback: fallback por variable para destinatarios sin cliente', () => {
    const raw = (o: Partial<CampaignRecipientCandidate> = {}): CampaignRecipientCandidate =>
      makeCandidate({ status: 'no_cliente', name: 'Nombre Tipeado', balanceDue: null, ...o });
    const linked = (o: Partial<CampaignRecipientCandidate> = {}): CampaignRecipientCandidate =>
      makeCandidate({ status: 'active', name: 'Cliente Real', balanceDue: 50000, ...o });

    it('crudo + name + fallback → usa el fallback', () => {
      const vars = resolveCampaignVariables({ '1': { source: 'name', fallback: 'cliente' } }, raw());
      expect(vars['1']).toBe('cliente');
    });

    it('crudo + name SIN fallback → usa el nombre tipeado (candidate.name)', () => {
      const vars = resolveCampaignVariables({ '1': { source: 'name' } }, raw({ name: '3364111111' }));
      expect(vars['1']).toBe('3364111111');
    });

    it('crudo + name + fallback vacío → usa el nombre tipeado (el fallback debe ser NO vacío para ganar)', () => {
      const vars = resolveCampaignVariables({ '1': { source: 'name', fallback: '' } }, raw({ name: 'Ana' }));
      expect(vars['1']).toBe('Ana');
    });

    it('VINCULADO + name + fallback → IGNORA el fallback, usa el nombre REAL del cliente', () => {
      const vars = resolveCampaignVariables({ '1': { source: 'name', fallback: 'cliente' } }, linked({ name: 'Juan Pérez' }));
      expect(vars['1']).toBe('Juan Pérez');
    });

    it('crudo + balanceDue + fallback → usa el fallback', () => {
      const vars = resolveCampaignVariables({ '1': { source: 'balanceDue', fallback: '—' } }, raw());
      expect(vars['1']).toBe('—');
    });

    it('crudo + balanceDue SIN fallback → cadena vacía (regla FIX-18, NUNCA "$0")', () => {
      const vars = resolveCampaignVariables({ '1': { source: 'balanceDue' } }, raw());
      expect(vars['1']).toBe('');
    });

    it('VINCULADO + balanceDue + fallback → IGNORA el fallback, usa el monto REAL formateado', () => {
      const vars = resolveCampaignVariables({ '1': { source: 'balanceDue', fallback: '—' } }, linked({ balanceDue: 50000 }));
      expect(vars['1']).toBe('$50.000');
    });

    it('literal → sin cambios (crudo o vinculado): usa entry.value, ignora fallback', () => {
      const spec = { '1': { source: 'literal' as const, value: 'fijo', fallback: 'IGNORADO' } };
      expect(resolveCampaignVariables(spec, raw())['1']).toBe('fijo');
      expect(resolveCampaignVariables(spec, linked())['1']).toBe('fijo');
    });

    it('via SendCampaign: recipient crudo (clientId null) + name/balanceDue con fallback → el fallback GANA en el envío', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([]); // universo vacío — no hay Client que resolver
      const templatePort = new InMemoryTemplateMessagingGateway();
      const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter());

      const { campaign } = await seedCampaign(campaignRepo, {
        variableSpec: {
          '1': { source: 'name', fallback: 'cliente' },
          '2': { source: 'balanceDue', fallback: 'consultá tu deuda' },
        },
        recipients: [{ clientId: null, contactName: 'Ana', phoneNormalized: '3364111111', phoneE164: '+5493364111111' }],
      });

      await uc.execute({ campaignId: campaign.id });

      // el candidate sintético lleva status 'no_cliente' → el fallback pisa el nombre tipeado y el balanceDue vacío
      expect(templatePort.calls[0].variables).toEqual({ '1': 'cliente', '2': 'consultá tu deuda' });
    });

    it('via SendCampaign: recipient VINCULADO ignora el fallback aunque esté seteado (usa su dato real)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([makeCandidate({ clientId: 'c1', name: 'Cliente Real', balanceDue: 5000 })]);
      const templatePort = new InMemoryTemplateMessagingGateway();
      const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter());

      const { campaign } = await seedCampaign(campaignRepo, {
        variableSpec: {
          '1': { source: 'name', fallback: 'cliente' },
          '2': { source: 'balanceDue', fallback: '—' },
        },
        recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
      });

      await uc.execute({ campaignId: campaign.id });

      expect(templatePort.calls[0].variables).toEqual({ '1': 'Cliente Real', '2': '$5.000' });
    });
  });

  // ── chatwoot-hub-sendpath (B4, D4) — flag ON: envío vía ChatwootGateway ─────
  describe('chatwoot-hub-sendpath (B4, D4) — flag ON: envío vía ChatwootGateway', () => {
    const APPROVED_DESCRIPTOR: TemplateDto = {
      contentSid: 'HXtest',
      friendlyName: 'Recordatorio deuda',
      language: 'es',
      variables: {},
      approvalStatus: 'approved',
      body: 'irrelevante (SendCampaign usa campaign.templateBody, no template.body)',
    };

    /** Selectivo por teléfono — el fake compartido sólo soporta fallo global. */
    class SelectiveFailChatwootGateway extends FakeChatwootGateway {
      constructor(private readonly failPhone: string) {
        super();
      }
      async createConversationWithTemplate(
        params: Parameters<FakeChatwootGateway['createConversationWithTemplate']>[0],
      ) {
        if (params.phoneE164 === this.failPhone) {
          throw new Error(`fake: Chatwoot unreachable for ${params.phoneE164}`);
        }
        return super.createConversationWithTemplate(params);
      }
    }

    it('flag ON pero DEPS wireadas (no ausentes) — sin seedear el flag en true, sigue OFF byte-idéntico (CHW-3)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([makeCandidate({ clientId: 'c1' })]);
      const templatePort = new InMemoryTemplateMessagingGateway();
      const chatwootGateway = new FakeChatwootGateway();
      const featureFlags = new InMemoryFeatureFlagRepository(); // sin seed → get() = null → OFF
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        undefined,
        undefined,
        chatwootGateway,
        featureFlags,
      );

      const { campaign } = await seedCampaign(campaignRepo, {
        recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.sentCount).toBe(1);
      expect(templatePort.calls).toHaveLength(1); // path Twilio-directo, intacto
      expect(chatwootGateway.createConversationWithTemplateCalls).toHaveLength(0);
    });

    it('SEND-2/CHW-2 modified: primer envío bajo ON (sin chatwootConversationId previo) → createConversationWithTemplate con args exactos + persistRecipientSent(providerId=String(chatwootMessageId)) + projectChatwootTemplateSend (NUNCA projectSentMessage)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([makeCandidate({ clientId: 'c1', name: 'Juan Pérez', balanceDue: 50000 })]);
      const templatePort = new InMemoryTemplateMessagingGateway({ templates: [APPROVED_DESCRIPTOR] });
      const chatwootGateway = new FakeChatwootGateway();
      chatwootGateway.createConversationWithTemplateResult = { chatwootConversationId: 900, chatwootMessageId: 9000 };
      const featureFlags = new InMemoryFeatureFlagRepository();
      featureFlags.seed('messaging-send-via-chatwoot', true);
      const projector = new FakeCampaignInboxProjector();
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        projector,
        undefined,
        chatwootGateway,
        featureFlags,
      );

      const { campaign } = await seedCampaign(campaignRepo, {
        templateRef: 'HXtest',
        templateBody: 'Hola {{1}}, tenés una deuda de {{2}}',
        variableSpec: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
        recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.sentCount).toBe(1);
      expect(templatePort.calls).toHaveLength(0); // CERO llamada a sendTemplate (Twilio-directo)
      expect(chatwootGateway.createConversationWithTemplateCalls).toEqual([
        {
          phoneE164: '+5493364000001',
          name: 'Juan Pérez',
          templateName: 'Recordatorio deuda',
          language: 'es',
          processedParams: { '1': 'Juan Pérez', '2': '$50.000' },
          content: 'Hola Juan Pérez, tenés una deuda de $50.000',
        },
      ]);

      const recipient = (await campaignRepo.listRecipients(campaign.id)).data[0]!;
      expect(recipient.status).toBe('sent');
      expect(recipient.providerId).toBe('9000');

      expect(projector.projectSentMessageCalls).toHaveLength(0);
      expect(projector.projectChatwootTemplateSendCalls).toHaveLength(1);
      expect(projector.projectChatwootTemplateSendCalls[0]).toMatchObject({
        chatwootConversationId: 900,
        chatwootMessageId: 9000,
        contactPhone: '+5493364000001',
        contactName: 'Juan Pérez',
        renderedBody: 'Hola Juan Pérez, tenés una deuda de $50.000',
      });
    });

    it('D7: descriptor no resuelve/no aprobado en el proveedor con ON → ABORTA el run (TemplateProviderConfigError), CERO recipients quemados a failed (siguen queued)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const candidates = Array.from({ length: 3 }, (_, i) => makeCandidate({ clientId: `c${i + 1}` }));
      const lookup = makeLookup(candidates);
      const templatePort = new InMemoryTemplateMessagingGateway(); // sin templates → HXtest no resuelve
      const chatwootGateway = new FakeChatwootGateway();
      const featureFlags = new InMemoryFeatureFlagRepository();
      featureFlags.seed('messaging-send-via-chatwoot', true);
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        undefined,
        undefined,
        chatwootGateway,
        featureFlags,
      );

      const { campaign } = await seedCampaign(campaignRepo, {
        templateRef: 'HXtest',
        recipients: candidates.map((c, i) => ({
          clientId: c.clientId,
          phoneNormalized: `336400000${i}`,
          phoneE164: `+549336400000${i}`,
        })),
      });

      await expect(uc.execute({ campaignId: campaign.id })).rejects.toBeInstanceOf(TemplateProviderConfigError);

      expect(chatwootGateway.createConversationWithTemplateCalls).toHaveLength(0);
      const recipients = await campaignRepo.listRecipients(campaign.id, { limit: 100 });
      expect(recipients.data.every((r) => r.status === 'queued')).toBe(true);
      expect(recipients.data.some((r) => r.status === 'failed')).toBe(false);
    });

    it('SEND-3 modified: SIN sendWithRetry en el path ON — un fallo del gateway Chatwoot NO reintenta, cae directo a failed', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([makeCandidate({ clientId: 'c1' })]);
      const templatePort = new InMemoryTemplateMessagingGateway({ templates: [APPROVED_DESCRIPTOR] });
      const chatwootGateway = new FakeChatwootGateway();
      chatwootGateway.failCreateConversationWithTemplate = true;
      const featureFlags = new InMemoryFeatureFlagRepository();
      featureFlags.seed('messaging-send-via-chatwoot', true);
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        undefined,
        // backoffOpts CON reintentos configurados — para probar que el path ON los IGNORA.
        { sleep: async () => {}, random: () => 0, maxRetries: 3 },
        chatwootGateway,
        featureFlags,
      );

      const { campaign } = await seedCampaign(campaignRepo, {
        templateRef: 'HXtest',
        recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(chatwootGateway.createConversationWithTemplateCalls).toHaveLength(1); // UN solo intento, sin retry
      expect(result.failedCount).toBe(1);
      expect(result.sentCount).toBe(0);
      const recipient = (await campaignRepo.listRecipients(campaign.id)).data[0]!;
      expect(recipient.status).toBe('failed');
      expect(recipient.error).toBeTruthy();
    });

    it('CHW-7 (bulk): Chatwoot caído para UN recipient → ese failed con error saneado, el resto sigue (FIX-5/SEND-2 sin cambios de contrato)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const candidates = [makeCandidate({ clientId: 'c1' }), makeCandidate({ clientId: 'c2' }), makeCandidate({ clientId: 'c3' })];
      const lookup = makeLookup(candidates);
      const templatePort = new InMemoryTemplateMessagingGateway({ templates: [APPROVED_DESCRIPTOR] });
      const failPhone = '+5493364000002';
      const chatwootGateway = new SelectiveFailChatwootGateway(failPhone);
      const featureFlags = new InMemoryFeatureFlagRepository();
      featureFlags.seed('messaging-send-via-chatwoot', true);
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        undefined,
        undefined,
        chatwootGateway,
        featureFlags,
      );

      const { campaign } = await seedCampaign(campaignRepo, {
        templateRef: 'HXtest',
        recipients: [
          { clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' },
          { clientId: 'c2', phoneNormalized: '3364000002', phoneE164: failPhone },
          { clientId: 'c3', phoneNormalized: '3364000003', phoneE164: '+5493364000003' },
        ],
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.status).toBe('done'); // NO abortó
      expect(result.sentCount).toBe(2);
      expect(result.failedCount).toBe(1);
      const recipients = await campaignRepo.listRecipients(campaign.id);
      const failed = recipients.data.find((r) => r.clientId === 'c2')!;
      expect(failed.status).toBe('failed');
      expect(failed.error).toBeTruthy();
      expect(failed.error).not.toMatch(/headers|Authorization|Bearer/i); // HIST-3 — nada crudo
    });

    it('D4: el flag se lee UNA vez por BATCH (no por recipient) — 60 recipients (3 páginas de 25) → featureFlags.get llamado 3 veces, no 60', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const TOTAL = 60;
      const candidates = Array.from({ length: TOTAL }, (_, i) => makeCandidate({ clientId: `c${String(i).padStart(3, '0')}` }));
      const lookup = makeLookup(candidates);
      const templatePort = new InMemoryTemplateMessagingGateway({ templates: [APPROVED_DESCRIPTOR] });
      const chatwootGateway = new FakeChatwootGateway();
      const featureFlags = new InMemoryFeatureFlagRepository();
      featureFlags.seed('messaging-send-via-chatwoot', true);
      const getSpy = jest.spyOn(featureFlags, 'get');
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        undefined,
        undefined,
        chatwootGateway,
        featureFlags,
      );

      const { campaign } = await seedCampaign(campaignRepo, {
        templateRef: 'HXtest',
        recipients: candidates.map((c, i) => ({
          clientId: c.clientId,
          phoneNormalized: `33640${String(i).padStart(5, '0')}`,
          phoneE164: `+54933640${String(i).padStart(5, '0')}`,
        })),
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.sentCount).toBe(TOTAL);
      expect(getSpy).toHaveBeenCalledTimes(Math.ceil(TOTAL / RESUME_PAGE_SIZE)); // 3, NUNCA 60
      expect(chatwootGateway.createConversationWithTemplateCalls).toHaveLength(TOTAL);
    });

    it('SEND-4: rateLimiter.acquire() se llama IGUAL en el path ON (contrato sin cambios)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const candidates = Array.from({ length: 5 }, (_, i) => makeCandidate({ clientId: `c${i + 1}` }));
      const lookup = makeLookup(candidates);
      const templatePort = new InMemoryTemplateMessagingGateway({ templates: [APPROVED_DESCRIPTOR] });
      const chatwootGateway = new FakeChatwootGateway();
      const featureFlags = new InMemoryFeatureFlagRepository();
      featureFlags.seed('messaging-send-via-chatwoot', true);
      const rateLimiter: RateLimiter = { acquire: jest.fn(async () => {}) };
      const uc = new SendCampaign(campaignRepo, lookup, templatePort, rateLimiter, undefined, undefined, chatwootGateway, featureFlags);

      const { campaign } = await seedCampaign(campaignRepo, {
        templateRef: 'HXtest',
        recipients: candidates.map((c, i) => ({
          clientId: c.clientId,
          phoneNormalized: `336400000${i}`,
          phoneE164: `+549336400000${i}`,
        })),
      });

      await uc.execute({ campaignId: campaign.id });

      expect(rateLimiter.acquire).toHaveBeenCalledTimes(5);
      expect(chatwootGateway.createConversationWithTemplateCalls).toHaveLength(5);
    });

    // F6 (fix wave) — el gateway no pudo extraer el chatwootMessageId del create (null). El
    // recipient DEBE quedar `sent` igual, `projectChatwootTemplateSend` se invoca con null (el
    // link no se pierde; el eco repone el mensaje), y `providerId` es TRAZABLE, nunca "NaN"/"null".
    it('F6: createConversationWithTemplate devuelve chatwootMessageId null → recipient sent, providerId trazable (no NaN/null), projectChatwootTemplateSend con null', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([makeCandidate({ clientId: 'c1', name: 'Juan Pérez' })]);
      const templatePort = new InMemoryTemplateMessagingGateway({ templates: [APPROVED_DESCRIPTOR] });
      const chatwootGateway = new FakeChatwootGateway();
      chatwootGateway.createConversationWithTemplateResult = { chatwootConversationId: 900, chatwootMessageId: null };
      const featureFlags = new InMemoryFeatureFlagRepository();
      featureFlags.seed('messaging-send-via-chatwoot', true);
      const projector = new FakeCampaignInboxProjector();
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        projector,
        undefined,
        chatwootGateway,
        featureFlags,
      );

      const { campaign } = await seedCampaign(campaignRepo, {
        templateRef: 'HXtest',
        templateBody: 'Hola {{1}}',
        variableSpec: { '1': { source: 'name' } },
        recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.sentCount).toBe(1);
      const recipient = (await campaignRepo.listRecipients(campaign.id)).data[0]!;
      expect(recipient.status).toBe('sent');
      expect(recipient.providerId).not.toBe('NaN');
      expect(recipient.providerId).not.toBe('null');
      expect(recipient.providerId).toContain('chatwoot-pending');
      expect(projector.projectChatwootTemplateSendCalls).toHaveLength(1);
      expect(projector.projectChatwootTemplateSendCalls[0]!.chatwootMessageId).toBeNull();
    });

    // F5 (fix wave) — la lectura del flag por-batch NO debe agregar superficie de fallo: si el
    // repo de flags EXPLOTA, se defaultea a OFF (Twilio-directo) y el batch entero drena, en vez
    // de abortar el run (regresión de robustez vs HEAD~6).
    it('F5: featureFlags.get EXPLOTA → drena el batch ENTERO por OFF (Twilio-directo), sin abortar', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const candidates = Array.from({ length: 3 }, (_, i) => makeCandidate({ clientId: `c${i + 1}` }));
      const lookup = makeLookup(candidates);
      const templatePort = new InMemoryTemplateMessagingGateway();
      const chatwootGateway = new FakeChatwootGateway();
      const throwingFlags: FeatureFlagRepository = {
        list: async () => [],
        get: async () => {
          throw new Error('feature flag repo caído');
        },
        setEnabled: async () => {
          throw new Error('feature flag repo caído');
        },
      };
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        undefined,
        undefined,
        chatwootGateway,
        throwingFlags,
      );

      const { campaign } = await seedCampaign(campaignRepo, {
        recipients: candidates.map((c, i) => ({
          clientId: c.clientId,
          phoneNormalized: `336400000${i}`,
          phoneE164: `+549336400000${i}`,
        })),
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.sentCount).toBe(3);
      expect(templatePort.calls).toHaveLength(3); // Twilio-directo por los 3 (path OFF)
      expect(chatwootGateway.createConversationWithTemplateCalls).toHaveLength(0);
    });

    // F9 (fix wave, CHW-3) — flip a mitad de campaña por el mecanismo REAL de batches. 5 recipients,
    // páginas keyset de 2 (SmallKeysetCampaignRepository): batch 1 (recipients 1-2) con flag OFF →
    // Twilio; el flag flipea a ON entre batches → batches 2-3 (recipients 3-5) vía Chatwoot.
    it('F9/CHW-3: 5 recipients en 2+ batches, OFF al arrancar (2 por Twilio) → flip ON entre batches (3-5 por Chatwoot); sentCount=5, cero reprocesos, cero duplicados', async () => {
      const inner = new InMemoryCampaignRepository();
      const campaignRepo = new SmallKeysetCampaignRepository(inner, 2);
      const candidates = Array.from({ length: 5 }, (_, i) => makeCandidate({ clientId: `c${i + 1}`, name: `Cliente ${i + 1}` }));
      const lookup = makeLookup(candidates);
      const templatePort = new InMemoryTemplateMessagingGateway({ templates: [APPROVED_DESCRIPTOR] });
      const chatwootGateway = new FakeChatwootGateway();
      const projector = new FakeCampaignInboxProjector();

      // OFF en el 1er batch (get #1), ON del 2do en adelante (get #2, #3, …) — el flip ocurre
      // ENTRE batches (drainQueue lee el flag una vez por batch).
      let flagReads = 0;
      const flippingFlags: FeatureFlagRepository = {
        list: async () => [],
        get: async (key: string) => {
          flagReads++;
          return { key, enabled: flagReads > 1, updatedAt: new Date().toISOString() };
        },
        setEnabled: async () => {
          throw new Error('n/a');
        },
      };

      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        projector,
        undefined,
        chatwootGateway,
        flippingFlags,
      );

      const { campaign } = await seedCampaign(campaignRepo, {
        templateRef: 'HXtest',
        templateBody: 'Hola {{1}}',
        variableSpec: { '1': { source: 'name' } },
        recipients: candidates.map((c, i) => ({
          clientId: c.clientId,
          phoneNormalized: `336400010${i}`,
          phoneE164: `+549336400010${i}`,
        })),
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.sentCount).toBe(5);
      // batch 1 (OFF): 2 recipients por Twilio-directo (el ORDEN exacto lo fija el keyset por
      // [createdAt,id], que no es la inserción — se asserta por conteo + cobertura, no por orden).
      expect(templatePort.calls).toHaveLength(2);
      expect(projector.projectSentMessageCalls).toHaveLength(2);
      // batches 2-3 (ON): los 3 restantes vía Chatwoot.
      expect(chatwootGateway.createConversationWithTemplateCalls).toHaveLength(3);
      expect(projector.projectChatwootTemplateSendCalls).toHaveLength(3);

      // cero reprocesos / cero duplicados: los 2 phones OFF y los 3 ON son DISJUNTOS y cubren los 5.
      const twilioPhones = templatePort.calls.map((c) => c.to);
      const chatwootPhones = chatwootGateway.createConversationWithTemplateCalls.map((c) => c.phoneE164);
      const allPhones = candidates.map((_, i) => `+549336400010${i}`);
      expect(new Set([...twilioPhones, ...chatwootPhones])).toEqual(new Set(allPhones)); // cobertura total
      expect(twilioPhones.filter((p) => chatwootPhones.includes(p))).toHaveLength(0); // ninguno en ambos paths

      const recipients = (await campaignRepo.listRecipients(campaign.id)).data;
      expect(recipients.filter((r) => r.status === 'sent')).toHaveLength(5); // los 5 sent exactamente
    });
  });

  // ── campaign-chatwoot-label (D4, CLBL-4/5/8) — applyChatwootLabel en processRecipient ──
  describe('campaign-chatwoot-label (D4, CLBL-4/5/8): applyChatwootLabel', () => {
    const LABEL_DESCRIPTOR: TemplateDto = {
      contentSid: 'HXtest',
      friendlyName: 'Recordatorio deuda',
      language: 'es',
      variables: {},
      approvalStatus: 'approved',
      body: 'Hola {{1}}',
    };

    /** Cuenta las llamadas a `addConversationLabels` y falla en la Nº indicada (1-based),
     * SIN importar a qué recipient corresponde — modela "Chatwoot caído para 1 de N" sin
     * depender del orden de procesamiento (que el keyset no garantiza de forma legible acá). */
    class NthLabelCallFailsChatwootGateway extends FakeChatwootGateway {
      private nextConversationId = 900;
      private labelCallCount = 0;
      constructor(private readonly failOnCallNumber: number | null = null) {
        super();
      }

      async createConversationWithTemplate(
        params: Parameters<FakeChatwootGateway['createConversationWithTemplate']>[0],
      ): Promise<{ chatwootConversationId: number; chatwootMessageId: number | null }> {
        await super.createConversationWithTemplate(params);
        const id = this.nextConversationId++;
        return { chatwootConversationId: id, chatwootMessageId: id * 10 };
      }

      async addConversationLabels(chatwootConversationId: number, labels: string[]): Promise<void> {
        this.labelCallCount++;
        this.addConversationLabelsCalls.push({ chatwootConversationId, labels: [...labels] });
        if (this.failOnCallNumber !== null && this.labelCallCount === this.failOnCallNumber) {
          throw new Error('fake: Chatwoot unreachable (addConversationLabels)');
        }
      }
    }

    it('CLBL-4/5: hilo NUEVO (find-or-create crea) — post-sent invoca addConversationLabels(cid, [label]) UNA vez', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([makeCandidate({ clientId: 'c1' })]);
      const templatePort = new InMemoryTemplateMessagingGateway({ templates: [LABEL_DESCRIPTOR] });
      const chatwootGateway = new FakeChatwootGateway();
      chatwootGateway.createConversationWithTemplateResult = { chatwootConversationId: 900, chatwootMessageId: 9000 };
      const featureFlags = new InMemoryFeatureFlagRepository();
      featureFlags.seed('messaging-send-via-chatwoot', true);
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        undefined,
        undefined,
        chatwootGateway,
        featureFlags,
      );

      const { campaign } = await seedCampaign(campaignRepo, {
        templateRef: 'HXtest',
        chatwootLabel: 'promo-julio',
        recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.sentCount).toBe(1);
      expect(chatwootGateway.addConversationLabelsCalls).toEqual([{ chatwootConversationId: 900, labels: ['promo-julio'] }]);
      const recipient = (await campaignRepo.listRecipients(campaign.id)).data[0]!;
      expect(recipient.status).toBe('sent');
    });

    it('CLBL-5: hilo YA EXISTENTE (find-or-create resuelve un id preexistente) — misma invocación, sin bifurcación de código', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([makeCandidate({ clientId: 'c1' })]);
      const templatePort = new InMemoryTemplateMessagingGateway({ templates: [LABEL_DESCRIPTOR] });
      const chatwootGateway = new FakeChatwootGateway();
      // id "preexistente" — simula que Chatwoot encontró (no creó) la conversación.
      chatwootGateway.createConversationWithTemplateResult = { chatwootConversationId: 555, chatwootMessageId: 5550 };
      const featureFlags = new InMemoryFeatureFlagRepository();
      featureFlags.seed('messaging-send-via-chatwoot', true);
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        undefined,
        undefined,
        chatwootGateway,
        featureFlags,
      );

      const { campaign } = await seedCampaign(campaignRepo, {
        templateRef: 'HXtest',
        chatwootLabel: 'promo-julio',
        recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.sentCount).toBe(1);
      expect(chatwootGateway.addConversationLabelsCalls).toEqual([{ chatwootConversationId: 555, labels: ['promo-julio'] }]);
    });

    it('CLBL-4: Chatwoot caído en 1 de 3 al etiquetar — los 3 quedan `sent`, campaña `done`, error logueado, NUNCA re-marca failed ni toca sentCount', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const candidates = [makeCandidate({ clientId: 'c1' }), makeCandidate({ clientId: 'c2' }), makeCandidate({ clientId: 'c3' })];
      const lookup = makeLookup(candidates);
      const templatePort = new InMemoryTemplateMessagingGateway({ templates: [LABEL_DESCRIPTOR] });
      const chatwootGateway = new NthLabelCallFailsChatwootGateway(2); // falla la 2da llamada, sin importar cuál recipient
      const featureFlags = new InMemoryFeatureFlagRepository();
      featureFlags.seed('messaging-send-via-chatwoot', true);
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        undefined,
        undefined,
        chatwootGateway,
        featureFlags,
      );

      const { campaign } = await seedCampaign(campaignRepo, {
        templateRef: 'HXtest',
        chatwootLabel: 'promo-julio',
        recipients: [
          { clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' },
          { clientId: 'c2', phoneNormalized: '3364000002', phoneE164: '+5493364000002' },
          { clientId: 'c3', phoneNormalized: '3364000003', phoneE164: '+5493364000003' },
        ],
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.status).toBe('done');
      expect(result.sentCount).toBe(3);
      expect(result.failedCount).toBe(0);
      const recipients = (await campaignRepo.listRecipients(campaign.id)).data;
      expect(recipients.every((r) => r.status === 'sent')).toBe(true); // NINGUNO re-marcado failed
      expect(chatwootGateway.addConversationLabelsCalls).toHaveLength(3); // se INTENTÓ para los 3
      expect(
        consoleErrorSpy.mock.calls.some((call) => String(call[0]).includes('etiquetado Chatwoot')),
      ).toBe(true); // logueado, best-effort

      consoleErrorSpy.mockRestore();
    });

    it('campaign.chatwootLabel=null → addConversationLabels NUNCA invocado (blast radius nulo)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([makeCandidate({ clientId: 'c1' })]);
      const templatePort = new InMemoryTemplateMessagingGateway({ templates: [LABEL_DESCRIPTOR] });
      const chatwootGateway = new FakeChatwootGateway();
      chatwootGateway.createConversationWithTemplateResult = { chatwootConversationId: 900, chatwootMessageId: 9000 };
      const featureFlags = new InMemoryFeatureFlagRepository();
      featureFlags.seed('messaging-send-via-chatwoot', true);
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        undefined,
        undefined,
        chatwootGateway,
        featureFlags,
      );

      const { campaign } = await seedCampaign(campaignRepo, {
        templateRef: 'HXtest',
        // chatwootLabel ausente → null (default del helper)
        recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.sentCount).toBe(1);
      expect(chatwootGateway.createConversationWithTemplateCalls).toHaveLength(1); // el envío SÍ ocurrió
      expect(chatwootGateway.addConversationLabelsCalls).toHaveLength(0); // pero CERO labeling
    });

    it('F1 (fix wave, MEDIUM): campaign.chatwootLabel=\'\' (string vacío, data vieja ya persistida) → addConversationLabels NUNCA invocado (el gate colapsa vacío/whitespace, no solo null)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([makeCandidate({ clientId: 'c1' })]);
      const templatePort = new InMemoryTemplateMessagingGateway({ templates: [LABEL_DESCRIPTOR] });
      const chatwootGateway = new FakeChatwootGateway();
      chatwootGateway.createConversationWithTemplateResult = { chatwootConversationId: 900, chatwootMessageId: 9000 };
      const featureFlags = new InMemoryFeatureFlagRepository();
      featureFlags.seed('messaging-send-via-chatwoot', true);
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        undefined,
        undefined,
        chatwootGateway,
        featureFlags,
      );

      const { campaign } = await seedCampaign(campaignRepo, {
        templateRef: 'HXtest',
        // simula data vieja persistida ANTES del fix de ruta F1(a) (`''` en vez de
        // `null`) — el use case NO debe re-consultar la ruta, solo el gate acá cuenta.
        chatwootLabel: '',
        recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.sentCount).toBe(1);
      expect(chatwootGateway.createConversationWithTemplateCalls).toHaveLength(1); // el envío SÍ ocurrió
      expect(chatwootGateway.addConversationLabelsCalls).toHaveLength(0); // pero CERO labeling
    });

    it('CLBL-8: flag OFF (Twilio-directo) aunque chatwootLabel esté seteado → addConversationLabels NUNCA invocado', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([makeCandidate({ clientId: 'c1' })]);
      const templatePort = new InMemoryTemplateMessagingGateway();
      const chatwootGateway = new FakeChatwootGateway();
      const featureFlags = new InMemoryFeatureFlagRepository(); // sin seed → OFF
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        undefined,
        undefined,
        chatwootGateway,
        featureFlags,
      );

      const { campaign } = await seedCampaign(campaignRepo, {
        chatwootLabel: 'promo-julio',
        recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
      });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.sentCount).toBe(1);
      expect(templatePort.calls).toHaveLength(1); // Twilio-directo, sin cambios
      expect(chatwootGateway.createConversationWithTemplateCalls).toHaveLength(0);
      expect(chatwootGateway.addConversationLabelsCalls).toHaveLength(0);
    });

    it('CLBL-8: resume — recipient ya `sent` de una corrida previa NO se reprocesa, cero nueva llamada a addConversationLabels', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([makeCandidate({ clientId: 'c1' }), makeCandidate({ clientId: 'c2' })]);
      const templatePort = new InMemoryTemplateMessagingGateway({ templates: [LABEL_DESCRIPTOR] });
      const chatwootGateway = new FakeChatwootGateway();
      chatwootGateway.createConversationWithTemplateResult = { chatwootConversationId: 900, chatwootMessageId: 9000 };
      const featureFlags = new InMemoryFeatureFlagRepository();
      featureFlags.seed('messaging-send-via-chatwoot', true);
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        undefined,
        undefined,
        chatwootGateway,
        featureFlags,
      );

      const { campaign, recipients } = await seedCampaign(campaignRepo, {
        templateRef: 'HXtest',
        chatwootLabel: 'promo-julio',
        recipients: [
          { clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' },
          { clientId: 'c2', phoneNormalized: '3364000002', phoneE164: '+5493364000002' },
        ],
      });
      // simula una corrida previa YA terminada para c1 (sin label — campaña vieja o corrida
      // interrumpida antes de este feature): resume NO debe reprocesarlo ni re-etiquetarlo.
      await campaignRepo.updateRecipient(recipients[0]!.id, { status: 'sent', providerId: 'SM-old1', sentAt: '2026-01-01T00:00:00.000Z' });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.sentCount).toBe(2); // el viejo + el nuevo, conteo REAL
      // SOLO el recipient nuevo (c2) pasó por applyChatwootLabel — el ya-sent quedó intacto.
      expect(chatwootGateway.addConversationLabelsCalls).toHaveLength(1);
      expect(chatwootGateway.createConversationWithTemplateCalls).toHaveLength(1);
    });

    it('recipient `failed` reintentado SÍ pasa por applyChatwootLabel (idempotente vía GET-unión-POST del adapter, D2)', async () => {
      const campaignRepo = new InMemoryCampaignRepository();
      const lookup = makeLookup([makeCandidate({ clientId: 'c1' })]);
      const templatePort = new InMemoryTemplateMessagingGateway({ templates: [LABEL_DESCRIPTOR] });
      const chatwootGateway = new FakeChatwootGateway();
      chatwootGateway.createConversationWithTemplateResult = { chatwootConversationId: 900, chatwootMessageId: 9000 };
      const featureFlags = new InMemoryFeatureFlagRepository();
      featureFlags.seed('messaging-send-via-chatwoot', true);
      const uc = new SendCampaign(
        campaignRepo,
        lookup,
        templatePort,
        new ImmediateRateLimiter(),
        undefined,
        undefined,
        chatwootGateway,
        featureFlags,
      );

      const { campaign, recipients } = await seedCampaign(campaignRepo, {
        templateRef: 'HXtest',
        chatwootLabel: 'promo-julio',
        recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
      });
      // simula un intento previo fallido (Chatwoot caído en el envío) — SIGUE en el
      // filtro `['queued','failed']`, se reprocesa completo en esta corrida.
      await campaignRepo.updateRecipient(recipients[0]!.id, { status: 'failed', error: 'intento previo caído' });

      const result = await uc.execute({ campaignId: campaign.id });

      expect(result.sentCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(chatwootGateway.addConversationLabelsCalls).toHaveLength(1);
    });
  });
});
