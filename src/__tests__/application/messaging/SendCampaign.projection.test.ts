/**
 * messaging-bulk-inbox (F1, T3) — SendCampaign proyecta al inbox tras el `sent`.
 * SEAM completo (lección #28): SendCampaign REAL + PrismaCampaignInboxProjector REAL
 * + repos in-memory. Cubre: proyección efectiva, IDEMPOTENCIA/best-effort AISLADA
 * (un fallo de la proyección NUNCA re-marca `failed` → jamás re-envía), BACKCOMPAT
 * (sin projector, comportamiento EXACTO de antes) y el helper puro renderTemplateBody.
 */
import { SendCampaign, renderTemplateBody } from '@application/use-cases/messaging/SendCampaign';
import { PrismaCampaignInboxProjector } from '@infrastructure/adapters/prisma/PrismaCampaignInboxProjector';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryTemplateMessagingGateway } from '@infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';
import { ImmediateRateLimiter } from '@infrastructure/adapters/in-memory/ImmediateRateLimiter';
import type { CampaignRecipientLookup, CampaignRecipientCandidate } from '@domain/ports/CustomerRepository';
import type { CampaignInboxProjector } from '@domain/ports/CampaignInboxProjector';
import type { CampaignRepository } from '@domain/ports/CampaignRepository';
import type { CampaignVariableSpec } from '@domain/entities/campaign';

function makeCandidate(overrides: Partial<CampaignRecipientCandidate> = {}): CampaignRecipientCandidate {
  return { clientId: 'c1', name: 'Juan', phone: '3364000001', balanceDue: 50000, whatsappOptOutAt: null, ...overrides };
}

function makeLookup(candidates: CampaignRecipientCandidate[]): CampaignRecipientLookup {
  const byId = new Map(candidates.map((c) => [c.clientId, { ...c }]));
  return { findRecipientCandidate: async (id: string) => (byId.has(id) ? { ...byId.get(id)! } : null) };
}

async function seedCampaign(
  campaignRepo: CampaignRepository,
  opts: {
    templateBody?: string | null;
    variableSpec?: CampaignVariableSpec;
    recipients: { clientId: string | null; contactName?: string | null; phoneNormalized: string; phoneE164: string }[];
  },
) {
  const campaign = await campaignRepo.create({
    name: 'Recordatorio',
    templateRef: 'HXabc',
    templateBody: opts.templateBody ?? null,
    segment: { statuses: ['late'] },
    variableSpec: opts.variableSpec ?? {},
    total: opts.recipients.length,
    createdById: 'u1',
  });
  await campaignRepo.bulkCreateRecipients(campaign.id, opts.recipients);
  return campaign;
}

describe('SendCampaign — proyección al inbox (T3)', () => {
  it('proyecta el mensaje enviado: Conversation bulk + ChatMessage outbound con el body RENDERIZADO + recipient.conversationId', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const conversationRepo = new InMemoryConversationRepository();
    const chatMessageRepo = new InMemoryChatMessageRepository();
    const projector = new PrismaCampaignInboxProjector(conversationRepo, chatMessageRepo, campaignRepo);
    const lookup = makeLookup([makeCandidate({ clientId: 'c1', name: 'Juan', balanceDue: 50000 })]);
    const uc = new SendCampaign(campaignRepo, lookup, new InMemoryTemplateMessagingGateway(), new ImmediateRateLimiter(), projector);

    const campaign = await seedCampaign(campaignRepo, {
      templateBody: 'Hola {{1}}, tenés una deuda de {{2}}',
      variableSpec: { '1': { source: 'name' }, '2': { source: 'balanceDue' } },
      recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
    });

    const result = await uc.execute({ campaignId: campaign.id });
    expect(result.sentCount).toBe(1);

    const conv = (await conversationRepo.list({ page: 1, limit: 10 })).data[0]!;
    expect(conv.origin).toBe('bulk');
    const messages = await chatMessageRepo.listByConversation(conv.id);
    expect(messages).toHaveLength(1);
    // FIX-18 — balanceDue 50000 → '$50.000' renderizado dentro del body real del template.
    expect(messages[0]!.content).toBe('Hola Juan, tenés una deuda de $50.000');
    expect(messages[0]!.direction).toBe('outbound');

    const recipient = (await campaignRepo.listRecipients(campaign.id)).data[0]!;
    expect(recipient.status).toBe('sent');
    expect(recipient.conversationId).toBe(conv.id);
  });

  it('best-effort AISLADA: si el projector TIRA, el recipient queda `sent` (NUNCA failed → jamás re-envía) y la campaña `done`', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const throwingProjector: CampaignInboxProjector = {
      projectSentMessage: jest.fn(async () => {
        throw new Error('DB hiccup proyectando al inbox');
      }),
    };
    const lookup = makeLookup([makeCandidate({ clientId: 'c1' })]);
    const templatePort = new InMemoryTemplateMessagingGateway();
    const uc = new SendCampaign(campaignRepo, lookup, templatePort, new ImmediateRateLimiter(), throwingProjector);

    const campaign = await seedCampaign(campaignRepo, {
      recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
    });

    const result = await uc.execute({ campaignId: campaign.id });

    expect(throwingProjector.projectSentMessage).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('done');
    expect(result.sentCount).toBe(1);
    expect(result.failedCount).toBe(0);
    const recipient = (await campaignRepo.listRecipients(campaign.id)).data[0]!;
    expect(recipient.status).toBe('sent'); // el envío aceptado NUNCA se re-marca failed
    expect(templatePort.calls).toHaveLength(1); // se envió UNA sola vez
  });

  it('BACKCOMPAT: sin projector (5º arg ausente) NO proyecta nada — comportamiento EXACTO de antes', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const conversationRepo = new InMemoryConversationRepository();
    const chatMessageRepo = new InMemoryChatMessageRepository();
    const lookup = makeLookup([makeCandidate({ clientId: 'c1' })]);
    // 4 args — SIN projector.
    const uc = new SendCampaign(campaignRepo, lookup, new InMemoryTemplateMessagingGateway(), new ImmediateRateLimiter());

    const campaign = await seedCampaign(campaignRepo, {
      templateBody: 'Hola {{1}}',
      variableSpec: { '1': { source: 'name' } },
      recipients: [{ clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' }],
    });

    const result = await uc.execute({ campaignId: campaign.id });

    expect(result.sentCount).toBe(1);
    expect((await conversationRepo.list({ page: 1, limit: 10 })).data).toHaveLength(0); // NADA proyectado
    const recipient = (await campaignRepo.listRecipients(campaign.id)).data[0]!;
    expect(recipient.status).toBe('sent');
    expect(recipient.conversationId).toBeNull();
  });

  // ── bulk-csv-recipients (D6/PRJ-1): contacto crudo aterriza en el inbox ───────
  it('PRJ-1: contacto crudo (clientId null) proyecta con contactName del CSV — Conversation + ChatMessage + conversationId seteado', async () => {
    const campaignRepo = new InMemoryCampaignRepository();
    const conversationRepo = new InMemoryConversationRepository();
    const chatMessageRepo = new InMemoryChatMessageRepository();
    const projector = new PrismaCampaignInboxProjector(conversationRepo, chatMessageRepo, campaignRepo);
    const lookup = makeLookup([]); // universo vacío — el crudo no lo necesita
    const uc = new SendCampaign(campaignRepo, lookup, new InMemoryTemplateMessagingGateway(), new ImmediateRateLimiter(), projector);

    const campaign = await seedCampaign(campaignRepo, {
      templateBody: 'Hola {{1}}',
      variableSpec: { '1': { source: 'name' } },
      recipients: [
        { clientId: null, contactName: 'Ana (CSV)', phoneNormalized: '3364777777', phoneE164: '+5493364777777' },
      ],
    });

    const result = await uc.execute({ campaignId: campaign.id });
    expect(result.sentCount).toBe(1);

    const conv = (await conversationRepo.list({ page: 1, limit: 10 })).data[0]!;
    expect(conv.contactName).toBe('Ana (CSV)');
    expect(conv.contactPhoneE164).toBe('+5493364777777');
    const messages = await chatMessageRepo.listByConversation(conv.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('Hola Ana (CSV)');

    const recipient = (await campaignRepo.listRecipients(campaign.id)).data[0]!;
    expect(recipient.conversationId).toBe(conv.id);
    expect(recipient.clientId).toBeNull();
  });
});

describe('renderTemplateBody (T3, helper puro)', () => {
  it('sustituye {{n}} por la variable resuelta', () => {
    expect(renderTemplateBody('Hola {{1}}, debés {{2}}', { '1': 'Juan', '2': '$50.000' })).toBe('Hola Juan, debés $50.000');
  });

  it('tolera espacios dentro de las llaves ({{ 1 }})', () => {
    expect(renderTemplateBody('Hola {{ 1 }}', { '1': 'Ana' })).toBe('Hola Ana');
  });

  it('placeholder sin variable → cadena vacía (nunca deja {{n}} crudo)', () => {
    expect(renderTemplateBody('Hola {{1}} {{2}}', { '1': 'Juan' })).toBe('Hola Juan ');
  });

  it('templateBody null/vacío → cadena vacía (degradación segura)', () => {
    expect(renderTemplateBody(null, { '1': 'x' })).toBe('');
    expect(renderTemplateBody('', { '1': 'x' })).toBe('');
  });
});
