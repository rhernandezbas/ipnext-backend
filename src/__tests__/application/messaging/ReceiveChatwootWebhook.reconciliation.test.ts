/**
 * messaging-bulk-inbox (F1, T5, FASE 2 — reconciliación AISLADA) — cuando el cliente
 * RESPONDE una conversación que arrancó como bulk, el webhook la ADOPTA (mismo id,
 * ahora con chatwootConversationId) en vez de crear un duplicado. NUNCA toca una
 * conversación Chatwoot existente. La clave de matcheo es E164 CANÓNICO (toWhatsAppE164),
 * NO normalizePhone (lossy con el "15" embebido → duplicados cross-format). In-memory
 * repos, sin mockear Prisma.
 */
import { ReceiveChatwootWebhook } from '@application/use-cases/messaging/ReceiveChatwootWebhook';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryWebhookDeliveryRepository } from '@infrastructure/adapters/in-memory/InMemoryWebhookDeliveryRepository';
import { toWhatsAppE164 } from '@application/use-cases/messaging/toWhatsAppE164';

const PHONE = '+5492324000000';
const E164 = toWhatsAppE164(PHONE)!;

function makeUseCase() {
  const conversationRepo = new InMemoryConversationRepository();
  const messageRepo = new InMemoryChatMessageRepository();
  const deliveryRepo = new InMemoryWebhookDeliveryRepository();
  const uc = new ReceiveChatwootWebhook(conversationRepo, messageRepo, deliveryRepo);
  return { uc, conversationRepo, messageRepo };
}

describe('ReceiveChatwootWebhook — FASE 2 reconciliación (T5)', () => {
  it('cliente responde (message_created inbound) → ADOPTA la conversación bulk (mismo id, ahora con chatwootConversationId), sin duplicar', async () => {
    const { uc, conversationRepo, messageRepo } = makeUseCase();
    // Conversación que arrancó como bulk (proyección previa), sin id de Chatwoot.
    const bulk = await conversationRepo.upsertBulkByPhone(E164, { contactName: 'Cliente', contactPhone: PHONE });
    expect(bulk.chatwootConversationId).toBeNull();

    await uc.execute('d-1', {
      event: 'message_created',
      id: 700,
      content: 'Hola, sí me interesa',
      message_type: 'incoming',
      created_at: 1735689600,
      conversation: { id: 55, meta: { sender: { name: 'Cliente', phone_number: PHONE } } },
      sender: { name: 'Cliente' },
    });

    // NO se creó un duplicado: sigue habiendo UNA sola conversación…
    const all = await conversationRepo.list({ page: 1, limit: 10 });
    expect(all.data).toHaveLength(1);
    // …y es LA MISMA (mismo id) ahora adoptada con el chatwootConversationId.
    const adopted = await conversationRepo.findByChatwootId(55);
    expect(adopted).not.toBeNull();
    expect(adopted!.id).toBe(bulk.id);
    expect(adopted!.chatwootConversationId).toBe(55);

    // el mensaje inbound del cliente aterrizó en ESA conversación
    const messages = await messageRepo.listByConversation(bulk.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.direction).toBe('inbound');
  });

  it('🔴 CROSS-FORMAT: bulk keyeado por E164 de un teléfono con "15" embebido; webhook manda el E164 de Chatwoot → ADOPTA (no duplicado)', async () => {
    const { uc, conversationRepo } = makeUseCase();
    // El projector guardó contactPhoneE164 desde un Client.phone con "15" embebido…
    const bulkE164 = toWhatsAppE164('011 15-2345-6789')!; // '+5491123456789'
    const bulk = await conversationRepo.upsertBulkByPhone(bulkE164, { contactName: 'Cliente', contactPhone: '011 15-2345-6789' });
    // …y Chatwoot reporta el MISMO número en E164 plano.
    const chatwootPhone = '+5491123456789';
    expect(toWhatsAppE164(chatwootPhone)).toBe(bulkE164); // ambos formatos colapsan al MISMO E164

    await uc.execute('d-x', {
      event: 'message_created',
      id: 710,
      content: 'Hola',
      message_type: 'incoming',
      created_at: 1735689600,
      conversation: { id: 88, meta: { sender: { name: 'Cliente', phone_number: chatwootPhone } } },
      sender: { name: 'Cliente' },
    });

    // Con normalizePhone (bug viejo) NO matchearía (clave bulk '111523456789' vs '1123456789').
    // Con toWhatsAppE164 (fix) matchea → adopción, no duplicado.
    const all = await conversationRepo.list({ page: 1, limit: 10 });
    expect(all.data).toHaveLength(1);
    const adopted = await conversationRepo.findByChatwootId(88);
    expect(adopted!.id).toBe(bulk.id);
    expect(adopted!.chatwootConversationId).toBe(88);
  });

  it('conversation_created → también adopta la conversación bulk pendiente (mismo id)', async () => {
    const { uc, conversationRepo } = makeUseCase();
    const bulk = await conversationRepo.upsertBulkByPhone(E164, { contactName: 'Cliente', contactPhone: PHONE });

    await uc.execute('d-2', {
      event: 'conversation_created',
      id: 77,
      status: 'open',
      meta: { sender: { name: 'Cliente', phone_number: PHONE } },
    });

    const all = await conversationRepo.list({ page: 1, limit: 10 });
    expect(all.data).toHaveLength(1);
    const adopted = await conversationRepo.findByChatwootId(77);
    expect(adopted!.id).toBe(bulk.id);
    expect(adopted!.chatwootConversationId).toBe(77);
  });

  it('NUNCA toca una conversación Chatwoot EXISTENTE: si el chatwootConversationId ya está tomado, NO adopta la bulk (queda con id null, sin colisión de UNIQUE)', async () => {
    const { uc, conversationRepo } = makeUseCase();
    // Existe una conversación bulk pendiente (id null)…
    const bulk = await conversationRepo.upsertBulkByPhone(E164, { contactName: 'Bulk', contactPhone: PHONE });
    // …y APARTE una conversación Chatwoot real que YA ocupa el id 55 (creada directo, sin
    // matchear la bulk porque upsertByChatwootId keyea por chatwootConversationId, no por teléfono).
    const existing = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 55, contactName: 'Existente', contactPhone: PHONE });

    await uc.execute('d-3', {
      event: 'message_created',
      id: 701,
      content: 'hola',
      message_type: 'incoming',
      created_at: 1735689600,
      conversation: { id: 55, meta: { sender: { name: 'Existente', phone_number: PHONE } } },
      sender: { name: 'Existente' },
    });

    // Siguen siendo DOS conversaciones: la bulk NO fue adoptada (55 ya estaba tomado).
    const all = await conversationRepo.list({ page: 1, limit: 10 });
    expect(all.data).toHaveLength(2);
    const bulkAfter = await conversationRepo.findById(bulk.id);
    expect(bulkAfter!.chatwootConversationId).toBeNull(); // intacta, no repointeada
    // la conversación Chatwoot existente (id 55) es la que recibió el mensaje
    const existingAfter = await conversationRepo.findByChatwootId(55);
    expect(existingAfter!.id).toBe(existing.id);
  });
});

/**
 * inbox-resolve (T5, LS-3) — verificación (design D4): Chatwoot reabre solo una
 * conversación resuelta cuando llega un mensaje inbound (o cualquier reopen manual
 * del agente en el panel de Chatwoot) — SIEMPRE via `CONVERSATION_STATUS_CHANGED`,
 * el mismo evento al que ya estamos suscriptos. CERO código de producción: el
 * handler existente (`handleConversationStatusChanged`) ya reconcilia con
 * `upsertByChatwootId({ chatwootConversationId, status })`, que por construcción
 * NUNCA toca assigneeId/areaId (campos LOCAL-only — ver
 * `InMemoryConversationRepository.upsertByChatwootId`). Este describe solo deja el
 * escenario cubierto EXPLÍCITO, tal como pide la spec (no estaba antes: los tests
 * de HOOK-4 existentes solo cubrían la dirección open→resolved).
 */
describe('ReceiveChatwootWebhook — LS-3 reopen automático reconcilia el mirror (inbox-resolve)', () => {
  it('resuelta + conversation_status_changed(open) → mirror open, assignee/area/preview intactos', async () => {
    const { uc, conversationRepo } = makeUseCase();
    conversationRepo.seedUsers([{ id: 'user-1', name: 'Agente Uno' }]);
    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 900,
      contactName: 'Cliente Resuelto',
      status: 'resolved',
      lastMessagePreview: 'gracias, todo resuelto',
    });
    await conversationRepo.updateLocalFields(conv.id, { assigneeId: 'user-1', areaId: 'area-1' });

    await uc.execute('d-reopen-1', { event: 'conversation_status_changed', id: 900, status: 'open' });

    const reopened = await conversationRepo.findByChatwootId(900);
    expect(reopened!.status).toBe('open');
    expect(reopened!.assigneeId).toBe('user-1'); // NO pisado
    expect(reopened!.areaId).toBe('area-1'); // NO pisado
    expect(reopened!.lastMessagePreview).toBe('gracias, todo resuelto'); // NO pisado
    expect(reopened!.contactName).toBe('Cliente Resuelto'); // NO pisado
  });

  it('redelivery idempotente: el mismo evento status_changed(open) reprocesado dos veces no revierte ni duplica', async () => {
    const { uc, conversationRepo } = makeUseCase();
    await conversationRepo.upsertByChatwootId({ chatwootConversationId: 901, status: 'resolved' });
    const payload = { event: 'conversation_status_changed', id: 901, status: 'open' };

    await uc.execute('d-reopen-2', payload);
    // Redelivery con el MISMO delivery id (disciplina PROCESS-THEN-RECORD, HOOK-3).
    await uc.execute('d-reopen-2', payload);

    const reopened = await conversationRepo.findByChatwootId(901);
    expect(reopened!.status).toBe('open');
    const all = await conversationRepo.list({ page: 1, limit: 10 });
    expect(all.data).toHaveLength(1); // sin duplicar
  });
});
