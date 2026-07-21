/**
 * messaging-bulk-inbox (F1, T2) — PrismaCampaignInboxProjector con repos in-memory
 * (SEAM: adapter REAL + ports in-memory, sin mockear Prisma). Cubre la proyección
 * al inbox (Conversation origin:'bulk' + ChatMessage outbound + recipient.conversationId)
 * y la IDEMPOTENCIA por campaignRecipientId (upsertBulkMessage) y por teléfono
 * normalizado (upsertBulkByPhone).
 */
import { PrismaCampaignInboxProjector } from '@infrastructure/adapters/prisma/PrismaCampaignInboxProjector';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import { toWhatsAppE164 } from '@application/use-cases/messaging/toWhatsAppE164';
import type { CampaignRepository } from '@domain/ports/CampaignRepository';
import type { CampaignRecipient } from '@domain/entities/campaign';

async function seedRecipient(
  campaignRepo: CampaignRepository,
  row: { clientId: string | null; contactName?: string | null; phoneNormalized: string; phoneE164: string },
): Promise<CampaignRecipient> {
  const campaign = await campaignRepo.create({
    name: 'Recordatorio',
    templateRef: 'HXabc',
    segment: { statuses: ['late'] },
    variableSpec: {},
    total: 1,
    createdById: 'u1',
  });
  const [recipient] = await campaignRepo.bulkCreateRecipients(campaign.id, [row]);
  return recipient;
}

function build() {
  const conversationRepo = new InMemoryConversationRepository();
  const chatMessageRepo = new InMemoryChatMessageRepository();
  const campaignRepo = new InMemoryCampaignRepository();
  const projector = new PrismaCampaignInboxProjector(conversationRepo, chatMessageRepo, campaignRepo);
  return { conversationRepo, chatMessageRepo, campaignRepo, projector };
}

describe('PrismaCampaignInboxProjector (T2)', () => {
  it('proyecta: crea una Conversation origin:bulk + un ChatMessage outbound(renderedBody) y setea recipient.conversationId', async () => {
    const { conversationRepo, chatMessageRepo, campaignRepo, projector } = build();
    const recipient = await seedRecipient(campaignRepo, {
      clientId: 'c1',
      phoneNormalized: '3364000001',
      phoneE164: '+5493364000001',
    });

    await projector.projectSentMessage({
      recipient,
      contactName: 'Juan Pérez',
      renderedBody: 'Hola Juan, tenés una deuda de $1.000',
      sentAt: '2026-07-14T10:00:00.000Z',
      providerId: 'SM1',
    });

    const list = await conversationRepo.list({ page: 1, limit: 10 });
    expect(list.data).toHaveLength(1);
    const conv = list.data[0]!;
    expect(conv.origin).toBe('bulk');
    expect(conv.chatwootConversationId).toBeNull();
    // clave = E164 canónico (recipient.phoneE164), NO normalizePhone.
    expect(conv.contactPhoneE164).toBe('+5493364000001');

    const messages = await chatMessageRepo.listByConversation(conv.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      direction: 'outbound',
      origin: 'bulk',
      content: 'Hola Juan, tenés una deuda de $1.000',
      chatwootCreatedAt: '2026-07-14T10:00:00.000Z',
      chatwootMessageId: null,
      campaignRecipientId: recipient.id,
    });

    const persisted = (await campaignRepo.listRecipients(recipient.campaignId)).data[0]!;
    expect(persisted.conversationId).toBe(conv.id);
  });

  it('idempotente por campaignRecipientId: re-proyectar el MISMO recipient NO duplica el ChatMessage', async () => {
    const { conversationRepo, chatMessageRepo, campaignRepo, projector } = build();
    const recipient = await seedRecipient(campaignRepo, {
      clientId: 'c1',
      phoneNormalized: '3364000001',
      phoneE164: '+5493364000001',
    });
    const input = {
      recipient,
      contactName: 'Juan Pérez',
      renderedBody: 'Hola',
      sentAt: '2026-07-14T10:00:00.000Z',
      providerId: 'SM1',
    };

    await projector.projectSentMessage(input);
    await projector.projectSentMessage(input); // re-proyección (resumibilidad)

    const list = await conversationRepo.list({ page: 1, limit: 10 });
    expect(list.data).toHaveLength(1);
    const messages = await chatMessageRepo.listByConversation(list.data[0]!.id);
    expect(messages).toHaveLength(1); // NO duplicado
  });

  it('upsertBulkByPhone: dos recipients con el MISMO teléfono normalizado caen en la MISMA conversación (append)', async () => {
    const { conversationRepo, chatMessageRepo, campaignRepo, projector } = build();
    const r1 = await seedRecipient(campaignRepo, { clientId: 'c1', phoneNormalized: '3364000001', phoneE164: '+5493364000001' });
    const r2 = await seedRecipient(campaignRepo, { clientId: 'c2', phoneNormalized: '3364000001', phoneE164: '+5493364000001' });

    await projector.projectSentMessage({ recipient: r1, contactName: 'Juan Pérez', renderedBody: 'msg-1', sentAt: '2026-07-14T10:00:00.000Z', providerId: 'SM1' });
    await projector.projectSentMessage({ recipient: r2, contactName: 'Juan Pérez', renderedBody: 'msg-2', sentAt: '2026-07-14T11:00:00.000Z', providerId: 'SM2' });

    const list = await conversationRepo.list({ page: 1, limit: 10 });
    expect(list.data).toHaveLength(1); // una sola conversación para ese teléfono
    const messages = await chatMessageRepo.listByConversation(list.data[0]!.id);
    expect(messages).toHaveLength(2); // ambos mensajes appendeados
    expect(list.data[0]!.lastMessagePreview).toBe('msg-2'); // bump del preview con el más reciente
  });

  it('🔴 CROSS-FORMAT: recipient.phoneE164 (de un teléfono con "15" embebido) matchea una conversación Chatwoot en E164 → MISMA conversación (no duplicado)', async () => {
    const { conversationRepo, chatMessageRepo, campaignRepo, projector } = build();
    const clientPhone15 = '011 15-2345-6789'; // formato AR con "15" móvil embebido
    const chatwootE164 = '+5491123456789'; // lo que Chatwoot reporta para ese mismo número
    const phoneE164 = toWhatsAppE164(clientPhone15)!; // canónico === chatwootE164
    expect(phoneE164).toBe(chatwootE164); // toWhatsAppE164 colapsa ambos formatos al MISMO E164

    // Conversación Chatwoot preexistente — 🟠 HIGH: upsertByChatwootId puebla contactPhoneE164.
    const chatConv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 10,
      contactName: 'Cliente',
      contactPhone: chatwootE164,
    });
    expect(chatConv.contactPhoneE164).toBe(chatwootE164);

    // Recipient con phoneE164 canónico; phoneNormalized es el LOSSY (111523456789) que
    // NO se usa como clave — con el bug viejo (keyear por normalizePhone) NO matchearía.
    const recipient = await seedRecipient(campaignRepo, { clientId: 'c1', phoneNormalized: '111523456789', phoneE164 });

    await projector.projectSentMessage({
      recipient,
      contactName: 'Juan Pérez',
      renderedBody: 'Hola',
      sentAt: '2026-07-14T10:00:00.000Z',
      providerId: 'SM1',
    });

    // Appendeó a la conversación Chatwoot existente (match por E164), sin crear un duplicado.
    const list = await conversationRepo.list({ page: 1, limit: 10 });
    expect(list.data).toHaveLength(1);
    expect(list.data[0]!.id).toBe(chatConv.id);
    const messages = await chatMessageRepo.listByConversation(chatConv.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.direction).toBe('outbound');
    const persisted = (await campaignRepo.listRecipients(recipient.campaignId)).data[0]!;
    expect(persisted.conversationId).toBe(chatConv.id);
  });

  // ── bulk-csv-recipients (D6/PRJ-1): contacto crudo (clientId null) ────────────
  it('PRJ-1: contacto crudo (clientId null) proyecta con el contactName pasado (del CSV), sin Client', async () => {
    const { conversationRepo, chatMessageRepo, campaignRepo, projector } = build();
    const recipient = await seedRecipient(campaignRepo, {
      clientId: null,
      contactName: 'Ana (CSV)',
      phoneNormalized: '3364555555',
      phoneE164: '+5493364555555',
    });

    await projector.projectSentMessage({
      recipient,
      contactName: 'Ana (CSV)',
      renderedBody: 'Hola Ana',
      sentAt: '2026-07-14T10:00:00.000Z',
      providerId: 'SM9',
    });

    const list = await conversationRepo.list({ page: 1, limit: 10 });
    expect(list.data).toHaveLength(1);
    expect(list.data[0]!.contactName).toBe('Ana (CSV)');
    expect(list.data[0]!.contactPhoneE164).toBe('+5493364555555');
    const persisted = (await campaignRepo.listRecipients(recipient.campaignId)).data[0]!;
    expect(persisted.conversationId).toBe(list.data[0]!.id);
    expect(persisted.clientId).toBeNull();
  });
});

describe('chatwoot-hub-sendpath (D9, B4.3) — projectChatwootTemplateSend', () => {
  it('upsertea la Conversation por el chatwootConversationId REAL + ChatMessage por chatwootMessageId + setea recipient.conversationId', async () => {
    const { conversationRepo, chatMessageRepo, campaignRepo, projector } = build();
    const recipient = await seedRecipient(campaignRepo, {
      clientId: 'c1',
      phoneNormalized: '3364000001',
      phoneE164: '+5493364000001',
    });

    await projector.projectChatwootTemplateSend({
      recipient,
      contactName: 'Juan Pérez',
      contactPhone: '+5493364000001',
      chatwootConversationId: 900,
      chatwootMessageId: 9000,
      renderedBody: 'Hola Juan, debés $1.000',
      sentAt: '2026-07-21T10:00:00.000Z',
    });

    const conv = await conversationRepo.findByChatwootId(900);
    expect(conv).not.toBeNull();
    expect(conv!.contactName).toBe('Juan Pérez');
    expect(conv!.contactPhoneE164).toBe('+5493364000001');

    const messages = await chatMessageRepo.listByConversation(conv!.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      direction: 'outbound',
      content: 'Hola Juan, debés $1.000',
      chatwootMessageId: 9000,
    });

    const persisted = (await campaignRepo.listRecipients(recipient.campaignId)).data[0]!;
    expect(persisted.conversationId).toBe(conv!.id);
  });

  it('CHW-4/D5: converge con el eco del webhook — re-proyectar el MISMO chatwootConversationId/chatwootMessageId NO duplica', async () => {
    const { conversationRepo, chatMessageRepo, campaignRepo, projector } = build();
    const recipient = await seedRecipient(campaignRepo, {
      clientId: 'c1',
      phoneNormalized: '3364000001',
      phoneE164: '+5493364000001',
    });
    const input = {
      recipient,
      contactName: 'Juan Pérez',
      contactPhone: '+5493364000001',
      chatwootConversationId: 901,
      chatwootMessageId: 9001,
      renderedBody: 'Hola',
      sentAt: '2026-07-21T10:00:00.000Z',
    };

    await projector.projectChatwootTemplateSend(input);
    // simula el eco `message_created` del webhook llegando después, mismo id — el
    // upsert de la Conversation converge por la MISMA @unique (chatwootConversationId).
    await conversationRepo.upsertByChatwootId({ chatwootConversationId: 901, contactName: 'Juan Pérez (webhook)' });
    await projector.projectChatwootTemplateSend(input);

    const list = await conversationRepo.list({ page: 1, limit: 10 });
    expect(list.data).toHaveLength(1); // NO duplica
    const messages = await chatMessageRepo.listByConversation(list.data[0]!.id);
    expect(messages).toHaveLength(1); // NO duplica
  });

  // F7 (fix wave) — el path ON no bumpeaba lastMessageAt/preview de la Conversation → la
  // conversación quedaba al FONDO del inbox (invisible). El path OFF (projectSentMessage) SÍ bumpea.
  it('F7: bumpea lastMessageAt (sentAt) + preview (renderedBody) de la Conversation', async () => {
    const { conversationRepo, projector, campaignRepo } = build();
    const recipient = await seedRecipient(campaignRepo, {
      clientId: 'c1',
      phoneNormalized: '3364000001',
      phoneE164: '+5493364000001',
    });

    await projector.projectChatwootTemplateSend({
      recipient,
      contactName: 'Juan Pérez',
      contactPhone: '+5493364000001',
      chatwootConversationId: 960,
      chatwootMessageId: 9600,
      renderedBody: 'Hola Juan, debés $1.000',
      sentAt: '2026-07-21T10:00:00.000Z',
    });

    const conv = await conversationRepo.findByChatwootId(960);
    expect(conv!.lastMessageAt).toBe('2026-07-21T10:00:00.000Z');
    expect(conv!.lastMessagePreview).toBe('Hola Juan, debés $1.000');
  });

  // F6 (fix wave) — chatwootMessageId null (el gateway no pudo extraer el id del create): SALTEA
  // el upsert del ChatMessage pero SIEMPRE crea la Conversation + setea recipient.conversationId
  // (el link NO se pierde; el eco `message_created` repone el mensaje después).
  it('F6: chatwootMessageId null → SALTEA el ChatMessage pero crea la Conversation + preserva el link recipient→conversación', async () => {
    const { conversationRepo, chatMessageRepo, campaignRepo, projector } = build();
    const recipient = await seedRecipient(campaignRepo, {
      clientId: 'c1',
      phoneNormalized: '3364000001',
      phoneE164: '+5493364000001',
    });

    await projector.projectChatwootTemplateSend({
      recipient,
      contactName: 'Juan Pérez',
      contactPhone: '+5493364000001',
      chatwootConversationId: 970,
      chatwootMessageId: null,
      renderedBody: 'Hola',
      sentAt: '2026-07-21T10:00:00.000Z',
    });

    const conv = await conversationRepo.findByChatwootId(970);
    expect(conv).not.toBeNull(); // Conversation creada IGUAL (bump de preview incluido)
    expect(conv!.lastMessagePreview).toBe('Hola');
    const messages = await chatMessageRepo.listByConversation(conv!.id);
    expect(messages).toHaveLength(0); // ChatMessage SALTEADO (el eco lo repone)
    const persisted = (await campaignRepo.listRecipients(recipient.campaignId)).data[0]!;
    expect(persisted.conversationId).toBe(conv!.id); // link preservado
  });

  it('contacto crudo (clientId null) también proyecta con el contactName/contactPhone pasados y preserva el lazo recipient→conversación', async () => {
    const { conversationRepo, campaignRepo, projector } = build();
    const recipient = await seedRecipient(campaignRepo, {
      clientId: null,
      contactName: 'Ana (CSV)',
      phoneNormalized: '3364555555',
      phoneE164: '+5493364555555',
    });

    await projector.projectChatwootTemplateSend({
      recipient,
      contactName: 'Ana (CSV)',
      contactPhone: '+5493364555555',
      chatwootConversationId: 902,
      chatwootMessageId: 9002,
      renderedBody: 'Hola Ana',
      sentAt: '2026-07-21T10:00:00.000Z',
    });

    const conv = await conversationRepo.findByChatwootId(902);
    expect(conv!.contactName).toBe('Ana (CSV)');
    const persisted = (await campaignRepo.listRecipients(recipient.campaignId)).data[0]!;
    expect(persisted.conversationId).toBe(conv!.id);
    expect(persisted.clientId).toBeNull();
  });
});
