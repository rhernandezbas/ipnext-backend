/**
 * messaging-inbox (F1, batch B4) — ReceiveChatwootWebhook (HOOK-3/HOOK-4/HOOK-5).
 * TDD with in-memory repos (InMemoryConversation/ChatMessage/WebhookDelivery) — no
 * Prisma mocking. HMAC/timestamp verification is B5's middleware, out of scope here:
 * this use case receives an ALREADY-VERIFIED (deliveryId, payload) pair.
 *
 * Payload shape (VERIFIED against a live Chatwoot `.37` `message_created` webhook —
 * no longer best-effort): the webhook's TOP-LEVEL `message_type` is a STRING
 * ("incoming"/"outgoing"/"activity"/"template"), NOT the numeric enum the GET API
 * uses (0/1/2/3) — both forms must be accepted (the numeric form still shows up via
 * `HttpChatwootGateway`'s GET-based fetch-on-open). Contact info travels under
 * `payload.conversation.meta.sender.{name,phone_number}` (NOT top-level `meta.sender`
 * — that shape is only correct for conversation-LEVEL events, `conversation_created`/
 * `conversation_status_changed`, whose own id/meta ARE top-level). `payload.private`
 * (bool) marks an internal agent note — never persisted, never bumps the preview.
 * `payload.conversation.can_reply` mirrors Chatwoot's 24h-window flag. Message-level
 * `sender.name` is the message's own sender display name (may be the agent on
 * outbound, the contact on inbound) — kept SEPARATE from `conversation.meta.sender`.
 */
import { ReceiveChatwootWebhook } from '@application/use-cases/messaging/ReceiveChatwootWebhook';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryWebhookDeliveryRepository } from '@infrastructure/adapters/in-memory/InMemoryWebhookDeliveryRepository';

function makeUseCase() {
  const conversationRepo = new InMemoryConversationRepository();
  const messageRepo = new InMemoryChatMessageRepository();
  const deliveryRepo = new InMemoryWebhookDeliveryRepository();
  const uc = new ReceiveChatwootWebhook(conversationRepo, messageRepo, deliveryRepo);
  return { uc, conversationRepo, messageRepo, deliveryRepo };
}

describe('ReceiveChatwootWebhook', () => {
  describe('HOOK-3 — idempotencia por delivery id', () => {
    it('first delivery of a message_created event processes and upserts the mirror', async () => {
      const { uc, conversationRepo } = makeUseCase();

      await uc.execute('delivery-1', {
        event: 'message_created',
        id: 501,
        content: 'Hola!',
        message_type: 'incoming',
        created_at: 1735689600,
        conversation: { id: 42, meta: { sender: { name: 'Juan Perez', phone_number: '+5492324421234' } } },
        sender: { name: 'Juan Perez' },
      });

      const conv = await conversationRepo.findByChatwootId(42);
      expect(conv).not.toBeNull();
      expect(conv!.lastMessagePreview).toBe('Hola!');
    });

    it('a duplicate delivery id does NOT reprocess nor rewrite the mirror', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();
      const payload = {
        event: 'message_created',
        id: 501,
        content: 'Hola!',
        message_type: 'incoming',
        created_at: 1735689600,
        conversation: { id: 42, meta: { sender: { name: 'Juan Perez', phone_number: '+5492324421234' } } },
        sender: { name: 'Juan Perez' },
      };

      await uc.execute('delivery-1', payload);
      await uc.execute('delivery-1', { ...payload, content: 'Reintento con contenido distinto' });

      const conv = await conversationRepo.findByChatwootId(42);
      expect(conv!.lastMessagePreview).toBe('Hola!'); // NOT overwritten by the duplicate

      const messages = await messageRepo.listByConversation(conv!.id);
      expect(messages).toHaveLength(1); // not duplicated
    });
  });

  describe('HOOK-4 — message_created', () => {
    it('inbound (message_type=0, numeric — GET API shape) upserts Conversation.lastMessageAt/preview AND a ChatMessage', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();

      await uc.execute('d-in', {
        event: 'message_created',
        id: 600,
        content: 'Necesito ayuda',
        message_type: 0,
        created_at: 1735689600,
        conversation: { id: 10, meta: { sender: { name: 'Cliente', phone_number: '+5492324000000' } } },
        sender: { name: 'Cliente' },
      });

      const conv = await conversationRepo.findByChatwootId(10);
      expect(conv!.lastMessagePreview).toBe('Necesito ayuda');
      expect(conv!.contactPhone).toBe('+5492324000000');

      const messages = await messageRepo.listByConversation(conv!.id);
      expect(messages).toEqual([
        expect.objectContaining({
          chatwootMessageId: 600,
          direction: 'inbound',
          content: 'Necesito ayuda',
        }),
      ]);
    });

    it('outbound (message_type=1, numeric) upserts a ChatMessage with direction outbound', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();

      await uc.execute('d-out', {
        event: 'message_created',
        id: 601,
        content: 'Ya te ayudo',
        message_type: 1,
        created_at: 1735689700,
        conversation: { id: 11, meta: { sender: { name: 'Cliente', phone_number: '+5492324111111' } } },
        sender: { name: 'Agente' },
      });

      const conv = await conversationRepo.findByChatwootId(11);
      const messages = await messageRepo.listByConversation(conv!.id);
      expect(messages).toEqual([
        expect.objectContaining({ chatwootMessageId: 601, direction: 'outbound' }),
      ]);
    });

    it('message_type 2 (activity, numeric) does NOT create a ChatMessage row (§7)', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();

      await uc.execute('d-activity', {
        event: 'message_created',
        id: 602,
        content: 'Conversación asignada a Agente X',
        message_type: 2,
        created_at: 1735689800,
        conversation: { id: 12 },
      });

      const conv = await conversationRepo.findByChatwootId(12);
      expect(conv).not.toBeNull();
      const messages = await messageRepo.listByConversation(conv!.id);
      expect(messages).toHaveLength(0);
    });

    it('message_type 3 (template, numeric) also skips the ChatMessage row', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();

      await uc.execute('d-template', {
        event: 'message_created',
        id: 603,
        content: 'Plantilla aprobada',
        message_type: 3,
        created_at: 1735689900,
        conversation: { id: 13 },
      });

      const conv = await conversationRepo.findByChatwootId(13);
      const messages = await messageRepo.listByConversation(conv!.id);
      expect(messages).toHaveLength(0);
      expect(conv).not.toBeNull();
    });
  });

  describe('H1 — message_type STRING (real webhook top-level shape)', () => {
    it('message_type "incoming" (string) is treated as inbound and persists a ChatMessage', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();

      await uc.execute('d-str-in', {
        event: 'message_created',
        id: 700,
        content: 'Hola desde WhatsApp',
        message_type: 'incoming',
        created_at: 1735690000,
        conversation: { id: 70 },
      });

      const conv = await conversationRepo.findByChatwootId(70);
      expect(conv).not.toBeNull();
      expect(conv!.lastMessagePreview).toBe('Hola desde WhatsApp');

      const messages = await messageRepo.listByConversation(conv!.id);
      expect(messages).toEqual([
        expect.objectContaining({ chatwootMessageId: 700, direction: 'inbound' }),
      ]);
    });

    it('message_type "outgoing" (string) is treated as outbound and persists a ChatMessage', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();

      await uc.execute('d-str-out', {
        event: 'message_created',
        id: 701,
        content: 'Ya te ayudo',
        message_type: 'outgoing',
        created_at: 1735690100,
        conversation: { id: 71 },
      });

      const conv = await conversationRepo.findByChatwootId(71);
      const messages = await messageRepo.listByConversation(conv!.id);
      expect(messages).toEqual([
        expect.objectContaining({ chatwootMessageId: 701, direction: 'outbound' }),
      ]);
    });

    it('message_type "activity" (string) skips the ChatMessage row, same as numeric 2', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();

      await uc.execute('d-str-activity', {
        event: 'message_created',
        id: 702,
        content: 'Conversación asignada a Agente X',
        message_type: 'activity',
        created_at: 1735690200,
        conversation: { id: 72 },
      });

      const conv = await conversationRepo.findByChatwootId(72);
      expect(conv).not.toBeNull();
      expect(await messageRepo.listByConversation(conv!.id)).toHaveLength(0);
    });

    it('message_type "template" (string) skips the ChatMessage row, same as numeric 3', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();

      await uc.execute('d-str-template', {
        event: 'message_created',
        id: 703,
        content: 'Plantilla aprobada',
        message_type: 'template',
        created_at: 1735690300,
        conversation: { id: 73 },
      });

      const conv = await conversationRepo.findByChatwootId(73);
      expect(await messageRepo.listByConversation(conv!.id)).toHaveLength(0);
      expect(conv).not.toBeNull();
    });
  });

  describe('H2 — private notes never persist a ChatMessage nor bump the preview', () => {
    it('private:true on an "outgoing" message is NOT persisted as a ChatMessage', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();

      await uc.execute('d-private', {
        event: 'message_created',
        id: 800,
        content: 'nota interna: cliente enojado',
        message_type: 'outgoing',
        private: true,
        created_at: 1735690400,
        conversation: { id: 80 },
      });

      const conv = await conversationRepo.findByChatwootId(80);
      expect(conv).not.toBeNull(); // conversation row still exists
      expect(await messageRepo.listByConversation(conv!.id)).toHaveLength(0);
    });

    it('private:true does NOT bump lastMessageAt/lastMessagePreview (an internal note is not a customer-facing message)', async () => {
      const { uc, conversationRepo } = makeUseCase();
      await conversationRepo.upsertByChatwootId({
        chatwootConversationId: 81,
        lastMessageAt: '2026-07-01T00:00:00.000Z',
        lastMessagePreview: 'ultimo mensaje real',
      });

      await uc.execute('d-private-2', {
        event: 'message_created',
        id: 801,
        content: 'nota interna',
        message_type: 'outgoing',
        private: true,
        created_at: 1735690500,
        conversation: { id: 81 },
      });

      const conv = await conversationRepo.findByChatwootId(81);
      expect(conv!.lastMessagePreview).toBe('ultimo mensaje real');
      expect(conv!.lastMessageAt).toBe('2026-07-01T00:00:00.000Z');
    });
  });

  describe('M1 — contacto viene de conversation.meta.sender (NO top-level meta.sender)', () => {
    it('captures contactName/contactPhone from payload.conversation.meta.sender on message_created', async () => {
      const { uc, conversationRepo } = makeUseCase();

      await uc.execute('d-m1', {
        event: 'message_created',
        id: 900,
        content: 'Hola, necesito soporte',
        message_type: 'incoming',
        created_at: 1735690600,
        conversation: {
          id: 90,
          meta: { sender: { name: 'Maria Lopez', phone_number: '+5492324555555' } },
        },
      });

      const conv = await conversationRepo.findByChatwootId(90);
      expect(conv!.contactName).toBe('Maria Lopez');
      expect(conv!.contactPhone).toBe('+5492324555555');
    });

    it('a top-level (non-nested) meta.sender is IGNORED for message_created — that shape does not exist on the real webhook', async () => {
      const { uc, conversationRepo } = makeUseCase();

      await uc.execute('d-m1-wrong-shape', {
        event: 'message_created',
        id: 901,
        content: 'hola',
        message_type: 'incoming',
        created_at: 1735690700,
        conversation: { id: 91 },
        meta: { sender: { name: 'Nombre Que No Deberia Aparecer', phone_number: '+5490000000' } },
      });

      const conv = await conversationRepo.findByChatwootId(91);
      expect(conv!.contactName).toBeNull();
      expect(conv!.contactPhone).toBeNull();
    });
  });

  describe('M2 — canReply del webhook (payload.conversation.can_reply)', () => {
    it('a message_created carrying conversation.can_reply:true refreshes the mirror canReply', async () => {
      const { uc, conversationRepo } = makeUseCase();
      await conversationRepo.upsertByChatwootId({ chatwootConversationId: 95, canReply: false });

      await uc.execute('d-m2', {
        event: 'message_created',
        id: 950,
        content: 'Hola!',
        message_type: 'incoming',
        created_at: 1735690800,
        conversation: { id: 95, can_reply: true },
      });

      const conv = await conversationRepo.findByChatwootId(95);
      expect(conv!.canReply).toBe(true);
    });

    it('conversation.can_reply absent leaves the mirror canReply untouched (undefined = no-op, not a forced false)', async () => {
      const { uc, conversationRepo } = makeUseCase();
      await conversationRepo.upsertByChatwootId({ chatwootConversationId: 96, canReply: true });

      await uc.execute('d-m2-absent', {
        event: 'message_created',
        id: 960,
        content: 'Hola de nuevo',
        message_type: 'incoming',
        created_at: 1735690900,
        conversation: { id: 96 },
      });

      const conv = await conversationRepo.findByChatwootId(96);
      expect(conv!.canReply).toBe(true); // untouched
    });
  });

  describe('§6 — activity/template no contaminan el preview de la conversacion', () => {
    it('an activity message_created does NOT bump lastMessagePreview/lastMessageAt', async () => {
      const { uc, conversationRepo } = makeUseCase();
      await conversationRepo.upsertByChatwootId({
        chatwootConversationId: 97,
        lastMessageAt: '2026-07-01T00:00:00.000Z',
        lastMessagePreview: 'ultimo mensaje de cliente',
      });

      await uc.execute('d-activity-preview', {
        event: 'message_created',
        id: 970,
        content: 'Conversación asignada a Agente X', // system text — must NOT leak into preview
        message_type: 'activity',
        created_at: 1735691000,
        conversation: { id: 97 },
      });

      const conv = await conversationRepo.findByChatwootId(97);
      expect(conv!.lastMessagePreview).toBe('ultimo mensaje de cliente');
      expect(conv!.lastMessageAt).toBe('2026-07-01T00:00:00.000Z');
    });

    it('a template message_created does NOT bump lastMessagePreview/lastMessageAt either', async () => {
      const { uc, conversationRepo } = makeUseCase();
      await conversationRepo.upsertByChatwootId({
        chatwootConversationId: 98,
        lastMessageAt: '2026-07-01T00:00:00.000Z',
        lastMessagePreview: 'ultimo mensaje de cliente',
      });

      await uc.execute('d-template-preview', {
        event: 'message_created',
        id: 980,
        content: 'Plantilla aprobada',
        message_type: 'template',
        created_at: 1735691100,
        conversation: { id: 98 },
      });

      const conv = await conversationRepo.findByChatwootId(98);
      expect(conv!.lastMessagePreview).toBe('ultimo mensaje de cliente');
      expect(conv!.lastMessageAt).toBe('2026-07-01T00:00:00.000Z');
    });
  });

  describe('HOOK-4 — conversation_created', () => {
    it('creates a new Conversation with initial contact and status', async () => {
      const { uc, conversationRepo } = makeUseCase();

      await uc.execute('d-conv-created', {
        event: 'conversation_created',
        id: 77,
        status: 'open',
        meta: { sender: { name: 'Nueva Contacto', phone_number: '+5492324999999' } },
      });

      const conv = await conversationRepo.findByChatwootId(77);
      expect(conv).not.toBeNull();
      expect(conv!.contactName).toBe('Nueva Contacto');
      expect(conv!.contactPhone).toBe('+5492324999999');
      expect(conv!.status).toBe('open');
    });
  });

  describe('HOOK-4 — conversation_status_changed', () => {
    it('updates ONLY the status of an existing Conversation, messages untouched', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();
      await conversationRepo.upsertByChatwootId({
        chatwootConversationId: 88,
        contactName: 'Cliente Y',
        status: 'open',
      });
      const conv0 = await conversationRepo.findByChatwootId(88);
      await messageRepo.upsertByChatwootMessageId({
        conversationId: conv0!.id,
        chatwootMessageId: 700,
        direction: 'inbound',
        content: 'hola',
        chatwootCreatedAt: new Date().toISOString(),
      });

      await uc.execute('d-status', { event: 'conversation_status_changed', id: 88, status: 'resolved' });

      const conv = await conversationRepo.findByChatwootId(88);
      expect(conv!.status).toBe('resolved');
      expect(conv!.contactName).toBe('Cliente Y'); // untouched

      const messages = await messageRepo.listByConversation(conv!.id);
      expect(messages).toHaveLength(1); // untouched
    });
  });

  describe('HOOK-5 — evento no suscrito', () => {
    it('an unknown event type is ignored without throwing and without persisting anything', async () => {
      const { uc, conversationRepo } = makeUseCase();

      await expect(
        uc.execute('d-unknown', { event: 'contact_updated', id: 999 }),
      ).resolves.toBeUndefined();

      const conv = await conversationRepo.findByChatwootId(999);
      expect(conv).toBeNull();
    });
  });

  describe('ROB-2 — process-then-record (a failed handler must NOT burn the delivery id)', () => {
    class ThrowingConversationRepo extends InMemoryConversationRepository {
      override async upsertByChatwootId(): Promise<never> {
        throw new Error('mirror write failed');
      }
    }

    it('when the handler throws, the delivery is NOT recorded — a Chatwoot retry with the SAME delivery id still reprocesses', async () => {
      const conversationRepo = new ThrowingConversationRepo();
      const messageRepo = new InMemoryChatMessageRepository();
      const deliveryRepo = new InMemoryWebhookDeliveryRepository();
      const uc = new ReceiveChatwootWebhook(conversationRepo, messageRepo, deliveryRepo);
      const payload = { event: 'conversation_created', id: 120, status: 'open' };

      await expect(uc.execute('delivery-fails', payload)).rejects.toThrow('mirror write failed');

      // Today's bug: recordIfNew() runs BEFORE the handler, so the delivery is already
      // marked "seen" even though processing never succeeded — the retry gets silently
      // swallowed by HOOK-3's dedup and the event is lost forever.
      expect(await deliveryRepo.hasSeen('chatwoot', 'delivery-fails')).toBe(false);
    });

    it('a delivery is recorded ONLY after the handler succeeds, so a genuine retry after a transient failure reprocesses correctly', async () => {
      let shouldThrow = true;
      class FlakyConversationRepo extends InMemoryConversationRepository {
        override async upsertByChatwootId(input: Parameters<InMemoryConversationRepository['upsertByChatwootId']>[0]) {
          if (shouldThrow) throw new Error('transient db error');
          return super.upsertByChatwootId(input);
        }
      }
      const conversationRepo = new FlakyConversationRepo();
      const messageRepo = new InMemoryChatMessageRepository();
      const deliveryRepo = new InMemoryWebhookDeliveryRepository();
      const uc = new ReceiveChatwootWebhook(conversationRepo, messageRepo, deliveryRepo);
      const payload = { event: 'conversation_created', id: 121, status: 'open' };

      await expect(uc.execute('delivery-retry', payload)).rejects.toThrow('transient db error');
      shouldThrow = false;
      await uc.execute('delivery-retry', payload); // Chatwoot's retry, same delivery id

      const conv = await conversationRepo.findByChatwootId(121);
      expect(conv).not.toBeNull(); // the retry actually got processed
      expect(await deliveryRepo.hasSeen('chatwoot', 'delivery-retry')).toBe(true);
    });

    it('a successfully processed delivery IS recorded, so a true duplicate still dedupes (HOOK-3 preserved)', async () => {
      const { uc, conversationRepo, deliveryRepo } = makeUseCase();
      const payload = { event: 'conversation_status_changed', id: 122, status: 'resolved' };
      await conversationRepo.upsertByChatwootId({ chatwootConversationId: 122, status: 'open' });

      await uc.execute('delivery-ok', payload);
      expect(await deliveryRepo.hasSeen('chatwoot', 'delivery-ok')).toBe(true);

      await conversationRepo.upsertByChatwootId({ chatwootConversationId: 122, status: 'open' }); // reopen directly
      await uc.execute('delivery-ok', payload); // duplicate — must be a no-op

      const conv = await conversationRepo.findByChatwootId(122);
      expect(conv!.status).toBe('open'); // NOT re-applied to 'resolved'
    });
  });
});
