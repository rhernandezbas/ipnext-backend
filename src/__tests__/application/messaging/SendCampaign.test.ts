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
import { SendCampaign, formatArs } from '@application/use-cases/messaging/SendCampaign';
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
    variableSpec?: CampaignVariableSpec;
    recipients: { clientId: string; phoneNormalized: string; phoneE164: string }[];
  },
) {
  const campaign = await campaignRepo.create({
    name: 'Test campaign',
    templateRef: opts.templateRef ?? 'HXtest',
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
});
