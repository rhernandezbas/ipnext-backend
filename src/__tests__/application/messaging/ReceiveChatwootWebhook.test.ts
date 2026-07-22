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
import { InMemoryChatMessageAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageAttachmentRepository';
import type { ChatMediaDownloadTrigger } from '@domain/ports/ChatMediaDownloadTrigger';

function makeUseCase() {
  const conversationRepo = new InMemoryConversationRepository();
  const messageRepo = new InMemoryChatMessageRepository();
  const deliveryRepo = new InMemoryWebhookDeliveryRepository();
  const uc = new ReceiveChatwootWebhook(conversationRepo, messageRepo, deliveryRepo);
  return { uc, conversationRepo, messageRepo, deliveryRepo };
}

function makeUseCaseWithAttachments() {
  const conversationRepo = new InMemoryConversationRepository();
  const messageRepo = new InMemoryChatMessageRepository();
  const deliveryRepo = new InMemoryWebhookDeliveryRepository();
  const attachmentRepo = new InMemoryChatMessageAttachmentRepository();
  const requestedDownloads: string[] = [];
  const trigger: ChatMediaDownloadTrigger = {
    requestDownload: (id: string) => {
      requestedDownloads.push(id);
    },
  };
  const uc = new ReceiveChatwootWebhook(conversationRepo, messageRepo, deliveryRepo, attachmentRepo, trigger);
  return { uc, conversationRepo, messageRepo, deliveryRepo, attachmentRepo, requestedDownloads };
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

  describe('messaging-inbox-notes (F1.5 fase D, NOTE-2/3) — private notes ARE persisted (marked), but never bump the preview', () => {
    it('NOTE-2: private:true on an "outgoing" message IS persisted as a ChatMessage marked isPrivate:true', async () => {
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
      expect(conv).not.toBeNull();
      const messages = await messageRepo.listByConversation(conv!.id);
      expect(messages).toEqual([
        expect.objectContaining({
          chatwootMessageId: 800,
          direction: 'outbound',
          content: 'nota interna: cliente enojado',
          isPrivate: true,
        }),
      ]);
    });

    it('NOTE-2: a normal message (private ausente) se persiste con isPrivate:false — comportamiento idéntico a hoy', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();

      await uc.execute('d-normal', {
        event: 'message_created',
        id: 802,
        content: 'hola, necesito ayuda',
        message_type: 'incoming',
        created_at: 1735690450,
        conversation: { id: 82 },
      });

      const conv = await conversationRepo.findByChatwootId(82);
      const messages = await messageRepo.listByConversation(conv!.id);
      expect(messages).toEqual([expect.objectContaining({ chatwootMessageId: 802, isPrivate: false })]);
    });

    it('NOTE-3: private:true does NOT bump lastMessageAt/lastMessagePreview (an internal note is not a customer-facing message)', async () => {
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

  describe('MEDIA-1 — captura sync de adjuntos (messaging-inbox-v2-media, Tanda 1)', () => {
    it('scenario 1 — dos webhooks con el MISMO chatwootAttachmentId dejan UNA sola fila', async () => {
      const { uc, conversationRepo, messageRepo, attachmentRepo } = makeUseCaseWithAttachments();
      const payload = {
        event: 'message_created',
        id: 1001,
        content: 'foto del comprobante',
        message_type: 'incoming',
        created_at: 1735690000,
        conversation: { id: 200 },
        attachments: [
          {
            id: 55,
            file_type: 'image',
            content_type: 'image/jpeg',
            data_url: 'https://chat.ipnext.com.ar/rails/active_storage/blobs/redirect/abc/foto.jpg',
            thumb_url: 'https://chat.ipnext.com.ar/rails/active_storage/representations/abc/thumb.jpg',
            file_size: 12345,
            width: 800,
            height: 600,
          },
        ],
      };

      await uc.execute('delivery-att-1', payload);
      await uc.execute('delivery-att-1-retry', { ...payload, content: 'reenvio de chatwoot' });

      const conv = await conversationRepo.findByChatwootId(200);
      const messages = await messageRepo.listByConversation(conv!.id);
      expect(messages).toHaveLength(1);
      const rows = await attachmentRepo.listByMessageIds([messages[0]!.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.chatwootAttachmentId).toBe(55);
      expect(rows[0]!.status).toBe('pending');
    });

    it('scenario 2 — reintento sobre un adjunto YA downloaded no lo revierte a pending', async () => {
      const { uc, conversationRepo, messageRepo, attachmentRepo } = makeUseCaseWithAttachments();
      const payload = {
        event: 'message_created',
        id: 1002,
        content: 'foto',
        message_type: 'incoming',
        created_at: 1735690100,
        conversation: { id: 201 },
        attachments: [
          {
            id: 56,
            file_type: 'image',
            content_type: 'image/jpeg',
            data_url: 'https://chat.ipnext.com.ar/rails/active_storage/blobs/redirect/def/foto.jpg',
          },
        ],
      };

      await uc.execute('delivery-att-2', payload);
      const conv = await conversationRepo.findByChatwootId(201);
      const messages = await messageRepo.listByConversation(conv!.id);
      const [row] = await attachmentRepo.listByMessageIds([messages[0]!.id]);
      await attachmentRepo.markDownloaded(row!.id, { storageKey: 'messaging/201/56.jpg' });

      await uc.execute('delivery-att-2-retry', payload); // Chatwoot re-sends the same webhook

      const [reprocessed] = await attachmentRepo.listByMessageIds([messages[0]!.id]);
      expect(reprocessed!.status).toBe('downloaded');
      expect(reprocessed!.storageKey).toBe('messaging/201/56.jpg');
    });

    it('scenario 3 — mensaje solo-attachment (content vacío) persiste el ChatMessage Y su adjunto pending', async () => {
      const { uc, conversationRepo, messageRepo, attachmentRepo } = makeUseCaseWithAttachments();

      await uc.execute('delivery-att-3', {
        event: 'message_created',
        id: 1003,
        content: '',
        message_type: 'incoming',
        created_at: 1735690200,
        conversation: { id: 202 },
        attachments: [
          { id: 57, file_type: 'image', content_type: 'image/jpeg', data_url: 'https://chat.ipnext.com.ar/x/57.jpg' },
        ],
      });

      const conv = await conversationRepo.findByChatwootId(202);
      const messages = await messageRepo.listByConversation(conv!.id);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe('');
      const rows = await attachmentRepo.listByMessageIds([messages[0]!.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('pending');
    });

    it('scenario 4 — fileType no-binario (location/contact/fallback/embed) NO crea fila, el mensaje se persiste igual', async () => {
      const { uc, conversationRepo, messageRepo, attachmentRepo } = makeUseCaseWithAttachments();

      await uc.execute('delivery-att-4', {
        event: 'message_created',
        id: 1004,
        content: 'te comparto mi ubicacion',
        message_type: 'incoming',
        created_at: 1735690300,
        conversation: { id: 203 },
        attachments: [
          { id: 58, file_type: 'location', data_url: 'https://chat.ipnext.com.ar/x/58' },
        ],
      });

      const conv = await conversationRepo.findByChatwootId(203);
      const messages = await messageRepo.listByConversation(conv!.id);
      expect(messages).toHaveLength(1);
      const rows = await attachmentRepo.listByMessageIds([messages[0]!.id]);
      expect(rows).toHaveLength(0);
    });

    it('captura además audio/video/file (todo el set binario), ignora contact/fallback/embed mezclados', async () => {
      const { uc, conversationRepo, messageRepo, attachmentRepo } = makeUseCaseWithAttachments();

      await uc.execute('delivery-att-mixed', {
        event: 'message_created',
        id: 1005,
        content: '',
        message_type: 'incoming',
        created_at: 1735690400,
        conversation: { id: 204 },
        attachments: [
          { id: 59, file_type: 'audio', content_type: 'audio/ogg', data_url: 'https://chat.ipnext.com.ar/x/59.ogg' },
          { id: 60, file_type: 'video', content_type: 'video/mp4', data_url: 'https://chat.ipnext.com.ar/x/60.mp4' },
          { id: 61, file_type: 'file', content_type: 'application/pdf', data_url: 'https://chat.ipnext.com.ar/x/61.pdf' },
          { id: 62, file_type: 'contact', data_url: 'https://chat.ipnext.com.ar/x/62' },
          { id: 63, file_type: 'fallback', data_url: 'https://chat.ipnext.com.ar/x/63' },
          { id: 64, file_type: 'embed', data_url: 'https://chat.ipnext.com.ar/x/64' },
        ],
      });

      const conv = await conversationRepo.findByChatwootId(204);
      const messages = await messageRepo.listByConversation(conv!.id);
      const rows = await attachmentRepo.listByMessageIds([messages[0]!.id]);
      expect(rows.map((r) => r.chatwootAttachmentId).sort()).toEqual([59, 60, 61]);
    });

    it('sin attachmentRepo/trigger inyectados (compat hacia atrás), el webhook procesa el mensaje normal sin tirar', async () => {
      const { uc, conversationRepo } = makeUseCase(); // NO attachmentRepo/trigger — 3-arg ctor
      await expect(
        uc.execute('delivery-att-no-repo', {
          event: 'message_created',
          id: 1006,
          content: 'sin adjuntos soportados',
          message_type: 'incoming',
          created_at: 1735690500,
          conversation: { id: 205 },
          attachments: [{ id: 65, file_type: 'image', content_type: 'image/jpeg', data_url: 'https://x/65.jpg' }],
        }),
      ).resolves.toBeUndefined();
      expect(await conversationRepo.findByChatwootId(205)).not.toBeNull();
    });

    it('scenario 24 — dispara el trigger fire-and-forget por cada adjunto binario nuevo', async () => {
      const { uc, requestedDownloads } = makeUseCaseWithAttachments();

      await uc.execute('delivery-att-trigger', {
        event: 'message_created',
        id: 1007,
        content: '',
        message_type: 'incoming',
        created_at: 1735690600,
        conversation: { id: 206 },
        attachments: [
          { id: 66, file_type: 'image', content_type: 'image/jpeg', data_url: 'https://x/66.jpg' },
        ],
      });

      expect(requestedDownloads).toHaveLength(1);
    });

    it('scenario 24 — si requestDownload lanza SÍNCRONO, el webhook igual procesa y responde (no propaga)', async () => {
      const conversationRepo = new InMemoryConversationRepository();
      const messageRepo = new InMemoryChatMessageRepository();
      const deliveryRepo = new InMemoryWebhookDeliveryRepository();
      const attachmentRepo = new InMemoryChatMessageAttachmentRepository();
      const throwingTrigger: ChatMediaDownloadTrigger = {
        requestDownload: () => {
          throw new Error('boom - infra bug en el trigger');
        },
      };
      const uc = new ReceiveChatwootWebhook(conversationRepo, messageRepo, deliveryRepo, attachmentRepo, throwingTrigger);

      await expect(
        uc.execute('delivery-att-throw', {
          event: 'message_created',
          id: 1008,
          content: '',
          message_type: 'incoming',
          created_at: 1735690700,
          conversation: { id: 207 },
          attachments: [{ id: 67, file_type: 'image', content_type: 'image/jpeg', data_url: 'https://x/67.jpg' }],
        }),
      ).resolves.toBeUndefined();

      const conv207 = await conversationRepo.findByChatwootId(207);
      expect(conv207).not.toBeNull();
      const messages = await messageRepo.listByConversation(conv207!.id);
      const rows = await attachmentRepo.listByMessageIds([messages[0]!.id]);
      expect(rows).toHaveLength(1); // the row was created before the (isolated) trigger threw
    });

    it('scenario #18 (messaging-inbox-v2-media Tanda 2 · spec-send.md SEND-5) — fila creada por el envío SÍNCRONO (SendMessage, ya `downloaded`) no se revierte cuando llega después el webhook "outgoing" del MISMO chatwootMessageId/chatwootAttachmentId', async () => {
      const { uc, conversationRepo, messageRepo, attachmentRepo } = makeUseCaseWithAttachments();
      // Simula lo que `SendMessage.execute` YA dejó antes de que este webhook llegue:
      // un ChatMessage outbound + su ChatMessageAttachment ya `downloaded` (SEND-5 —
      // nace así en el envío síncrono, nunca pasa por 'pending' esperando este webhook).
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 300, canReply: true });
      const message = await messageRepo.upsertByChatwootMessageId({
        conversationId: conv!.id,
        chatwootMessageId: 2001,
        direction: 'outbound',
        content: 'mirá la factura',
        chatwootCreatedAt: '2026-07-11T12:00:00.000Z',
      });
      const row = await attachmentRepo.upsertByChatwootAttachmentId({
        messageId: message.id,
        chatwootAttachmentId: 7002,
        fileType: 'image',
        contentType: 'image/jpeg',
        sourceUrl: 'https://chat.ipnext.com.ar/x/7002.jpg',
      });
      await attachmentRepo.markDownloaded(row.id, { storageKey: `messaging/${conv!.id}/${row.id}.jpg` });

      // El webhook "message_created"/outgoing que Chatwoot dispara DESPUÉS del envío
      // síncrono, para el MISMO chatwootMessageId/chatwootAttachmentId.
      await uc.execute('delivery-outgoing-echo', {
        event: 'message_created',
        id: 2001,
        content: 'mirá la factura',
        message_type: 'outgoing',
        created_at: 1735690000,
        conversation: { id: 300 },
        attachments: [
          { id: 7002, file_type: 'image', content_type: 'image/jpeg', data_url: 'https://chat.ipnext.com.ar/x/7002.jpg' },
        ],
      });

      const [reprocessed] = await attachmentRepo.listByMessageIds([message.id]);
      expect(reprocessed!.status).toBe('downloaded'); // NOT revertido a 'pending'
      expect(reprocessed!.storageKey).toBe(`messaging/${conv!.id}/${row.id}.jpg`); // NOT limpiado
      const messages = await messageRepo.listByConversation(conv!.id);
      expect(messages).toHaveLength(1); // no duplicado
    });
  });

  describe('messaging-inbox-polish (F1.5) — preview WhatsApp-style para mensajes solo-media', () => {
    it('último mensaje solo-imagen (content vacío) → preview "📷 Imagen"', async () => {
      const { uc, conversationRepo } = makeUseCase();

      await uc.execute('delivery-preview-image', {
        event: 'message_created',
        id: 2100,
        content: '',
        message_type: 'incoming',
        created_at: 1735700000,
        conversation: { id: 410 },
        attachments: [
          { id: 90, file_type: 'image', content_type: 'image/jpeg', data_url: 'https://x/90.jpg' },
        ],
      });

      const conv = await conversationRepo.findByChatwootId(410);
      expect(conv!.lastMessagePreview).toBe('📷 Imagen');
    });

    it('último mensaje solo-video (content null) → preview "🎥 Video"', async () => {
      const { uc, conversationRepo } = makeUseCase();

      await uc.execute('delivery-preview-video', {
        event: 'message_created',
        id: 2101,
        content: null,
        message_type: 'incoming',
        created_at: 1735700100,
        conversation: { id: 411 },
        attachments: [
          { id: 91, file_type: 'video', content_type: 'video/mp4', data_url: 'https://x/91.mp4' },
        ],
      });

      const conv = await conversationRepo.findByChatwootId(411);
      expect(conv!.lastMessagePreview).toBe('🎥 Video');
    });

    it('último mensaje solo-audio → preview "🎵 Audio"', async () => {
      const { uc, conversationRepo } = makeUseCase();

      await uc.execute('delivery-preview-audio', {
        event: 'message_created',
        id: 2102,
        content: '',
        message_type: 'incoming',
        created_at: 1735700200,
        conversation: { id: 412 },
        attachments: [
          { id: 92, file_type: 'audio', content_type: 'audio/ogg', data_url: 'https://x/92.ogg' },
        ],
      });

      const conv = await conversationRepo.findByChatwootId(412);
      expect(conv!.lastMessagePreview).toBe('🎵 Audio');
    });

    it('último mensaje solo-file (documento) → preview "📎 Archivo"', async () => {
      const { uc, conversationRepo } = makeUseCase();

      await uc.execute('delivery-preview-file', {
        event: 'message_created',
        id: 2103,
        content: '',
        message_type: 'incoming',
        created_at: 1735700300,
        conversation: { id: 413 },
        attachments: [
          { id: 93, file_type: 'file', content_type: 'application/pdf', data_url: 'https://x/93.pdf' },
        ],
      });

      const conv = await conversationRepo.findByChatwootId(413);
      expect(conv!.lastMessagePreview).toBe('📎 Archivo');
    });

    it('con caption (content Y media) el preview usa el content — la caption manda sobre el emoji, como WhatsApp', async () => {
      const { uc, conversationRepo } = makeUseCase();

      await uc.execute('delivery-preview-caption', {
        event: 'message_created',
        id: 2104,
        content: 'mirá el comprobante',
        message_type: 'incoming',
        created_at: 1735700400,
        conversation: { id: 414 },
        attachments: [
          { id: 94, file_type: 'image', content_type: 'image/jpeg', data_url: 'https://x/94.jpg' },
        ],
      });

      const conv = await conversationRepo.findByChatwootId(414);
      expect(conv!.lastMessagePreview).toBe('mirá el comprobante');
    });

    it('múltiples adjuntos sin texto → preview con el count ("📎 N archivos")', async () => {
      const { uc, conversationRepo } = makeUseCase();

      await uc.execute('delivery-preview-multi', {
        event: 'message_created',
        id: 2105,
        content: '',
        message_type: 'incoming',
        created_at: 1735700500,
        conversation: { id: 415 },
        attachments: [
          { id: 95, file_type: 'image', content_type: 'image/jpeg', data_url: 'https://x/95.jpg' },
          { id: 96, file_type: 'file', content_type: 'application/pdf', data_url: 'https://x/96.pdf' },
        ],
      });

      const conv = await conversationRepo.findByChatwootId(415);
      expect(conv!.lastMessagePreview).toBe('📎 2 archivos');
    });

    it('sin media (attachments no-binarios, ej. location) y sin texto → mantiene el fallback actual, sin regresión', async () => {
      const { uc, conversationRepo } = makeUseCase();

      await uc.execute('delivery-preview-no-media', {
        event: 'message_created',
        id: 2106,
        content: '',
        message_type: 'incoming',
        created_at: 1735700600,
        conversation: { id: 416 },
        attachments: [
          { id: 97, file_type: 'location', data_url: 'https://x/97' },
        ],
      });

      const conv = await conversationRepo.findByChatwootId(416);
      expect(conv!.lastMessagePreview).toBe(''); // comportamiento previo preservado (retrocompat)
    });
  });

  // ─── F1.5-C2 (asignación) — preservación: el webhook NUNCA pisa assigneeId/areaId ─
  describe('F1.5-C2 — assigneeId/areaId son LOCALES, el webhook nunca los toca', () => {
    it('un message_created sobre una conversación YA asignada preserva assigneeId/areaId', async () => {
      const { uc, conversationRepo } = makeUseCase();
      conversationRepo.seedUsers([{ id: 'user-1', name: 'Agente Uno' }]);
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 500, status: 'open' });
      await conversationRepo.updateLocalFields(conv.id, { assigneeId: 'user-1', areaId: 'area-1' });

      await uc.execute('delivery-assign-preserve', {
        event: 'message_created',
        id: 9001,
        content: 'nuevo mensaje entrante',
        message_type: 'incoming',
        created_at: 1735700700,
        conversation: { id: 500, meta: { sender: { name: 'Cliente X', phone_number: '+5492324000099' } } },
        sender: { name: 'Cliente X' },
      });

      const updated = await conversationRepo.findByChatwootId(500);
      expect(updated!.lastMessagePreview).toBe('nuevo mensaje entrante'); // sí se actualizó (mirror-driven)
      expect(updated!.assigneeId).toBe('user-1'); // NO pisado
      expect(updated!.areaId).toBe('area-1'); // NO pisado
    });

    it('un conversation_status_changed sobre una conversación YA asignada preserva assigneeId/areaId', async () => {
      const { uc, conversationRepo } = makeUseCase();
      conversationRepo.seedUsers([{ id: 'user-1', name: 'Agente Uno' }]);
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 501, status: 'open' });
      await conversationRepo.updateLocalFields(conv.id, { assigneeId: 'user-1', areaId: 'area-1' });

      await uc.execute('delivery-status-preserve', {
        event: 'conversation_status_changed',
        id: 501,
        status: 'resolved',
      });

      const updated = await conversationRepo.findByChatwootId(501);
      expect(updated!.status).toBe('resolved'); // sí se actualizó
      expect(updated!.assigneeId).toBe('user-1'); // NO pisado
      expect(updated!.areaId).toBe('area-1'); // NO pisado
    });
  });

  describe('chatwoot-hub-sendpath (B5, CHW-5) — message_updated → deliveryStatus failed', () => {
    it('con content_attributes.external_error no-vacío → deliveryStatus=failed + deliveryError saneado (trim)', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 900, status: 'open' });
      await messageRepo.upsertByChatwootMessageId({
        conversationId: conv.id,
        chatwootMessageId: 777,
        direction: 'outbound',
        content: 'Hola, debés $5.000',
        chatwootCreatedAt: new Date().toISOString(),
      });

      await uc.execute('d-mu-1', {
        event: 'message_updated',
        id: 777,
        content_attributes: { external_error: '  Template not found  ' },
      });

      const messages = await messageRepo.listByConversation(conv.id);
      expect(messages).toHaveLength(1); // no duplica
      expect(messages[0]!.deliveryStatus).toBe('failed');
      expect(messages[0]!.deliveryError).toBe('Template not found'); // trimeado
    });

    it('SIN external_error (delivered/read, indistinguibles) → no-op, deliveryStatus no cambia', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 901, status: 'open' });
      await messageRepo.upsertByChatwootMessageId({
        conversationId: conv.id,
        chatwootMessageId: 778,
        direction: 'outbound',
        content: 'Hola',
        chatwootCreatedAt: new Date().toISOString(),
      });

      await uc.execute('d-mu-2', { event: 'message_updated', id: 778 });

      const messages = await messageRepo.listByConversation(conv.id);
      expect(messages[0]!.deliveryStatus).toBeNull();
      expect(messages[0]!.deliveryError).toBeNull();
    });

    it('external_error vacío tras trim (string en blanco) → no-op', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 902, status: 'open' });
      await messageRepo.upsertByChatwootMessageId({
        conversationId: conv.id,
        chatwootMessageId: 779,
        direction: 'outbound',
        content: 'Hola',
        chatwootCreatedAt: new Date().toISOString(),
      });

      await uc.execute('d-mu-3', { event: 'message_updated', id: 779, content_attributes: { external_error: '   ' } });

      const messages = await messageRepo.listByConversation(conv.id);
      expect(messages[0]!.deliveryStatus).toBeNull();
    });

    // F4-bis (re-review) — CORRIGE F4: el F4 original tragaba este caso y devolvía un boolean
    // interno que NUNCA generaba un retry real (`execute` es `void`, la ruta responde 200
    // SIEMPRE — Chatwoot/Sidekiq sólo reacciona a non-2xx). Simetría ROB-2 con
    // `handleMessageCreated`: la fila aún no espejada es RETRIABLE → LANZA.
    it('F4-bis: fila ausente en el mirror (mensaje aún no proyectado) + external_error → RECHAZA (retriable, ROB-2) y la delivery NO queda vista', async () => {
      const { uc, deliveryRepo } = makeUseCase();

      await expect(
        uc.execute('d-mu-4', { event: 'message_updated', id: 99999, content_attributes: { external_error: 'Template not found' } }),
      ).rejects.toThrow(/fila 99999 aún no espejada/);

      expect(await deliveryRepo.hasSeen('chatwoot', 'd-mu-4')).toBe(false); // NO vista → Chatwoot puede reintentar
    });

    // F4-bis (re-review) — SIN external_error, aunque la fila esté ausente, sigue siendo el
    // no-op de siempre (delivered/read son indistinguibles y no dependen de que la fila exista):
    // 200, delivery vista. Pin explícito para no confundir este caso con el de arriba.
    it('SIN external_error (delivered/read) y fila AUSENTE → sigue siendo no-op visto (200), NUNCA lanza', async () => {
      const { uc, deliveryRepo } = makeUseCase();

      await expect(
        uc.execute('d-mu-noerr-norow', { event: 'message_updated', id: 424242 }),
      ).resolves.toBeUndefined();

      expect(await deliveryRepo.hasSeen('chatwoot', 'd-mu-noerr-norow')).toBe(true);
    });

    // F2 (fix wave) — Chatwoot puede mandar `external_error` como NÚMERO (código Twilio, ej. 63016)
    // u OBJETO. La curación hacía `raw.trim()` → TypeError → 500 → retry storm. Debe coaccionar seguro.
    it('F2: external_error NUMÉRICO (63016) → NO lanza, marca failed con el string coaccionado', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 910, status: 'open' });
      await messageRepo.upsertByChatwootMessageId({
        conversationId: conv.id,
        chatwootMessageId: 6301,
        direction: 'outbound',
        content: 'Hola',
        chatwootCreatedAt: new Date().toISOString(),
      });

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        uc.execute('d-mu-num', { event: 'message_updated', id: 6301, content_attributes: { external_error: 63016 as any } }),
      ).resolves.toBeUndefined();

      const messages = await messageRepo.listByConversation(conv.id);
      expect(messages[0]!.deliveryStatus).toBe('failed');
      expect(messages[0]!.deliveryError).toBe('63016');
    });

    it('F2: external_error OBJETO → NO lanza, marca failed con el JSON serializado (defensa en profundidad)', async () => {
      const { uc, conversationRepo, messageRepo } = makeUseCase();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 911, status: 'open' });
      await messageRepo.upsertByChatwootMessageId({
        conversationId: conv.id,
        chatwootMessageId: 6302,
        direction: 'outbound',
        content: 'Hola',
        chatwootCreatedAt: new Date().toISOString(),
      });

      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        uc.execute('d-mu-obj', { event: 'message_updated', id: 6302, content_attributes: { external_error: { code: 1 } as any } }),
      ).resolves.toBeUndefined();

      const messages = await messageRepo.listByConversation(conv.id);
      expect(messages[0]!.deliveryStatus).toBe('failed');
      expect(messages[0]!.deliveryError).toBe('{"code":1}');
    });

    // F4-bis (re-review) — message_updated (con error) llega ANTES que message_created (fila
    // aún no espejada) → 1er intento RECHAZA (retriable) y NO se marca vista. El eco
    // `message_created` (en vuelo, llega después) crea la fila. Chatwoot (Sidekiq) re-entrega el
    // MISMO evento tras el 500 anterior — el segundo `execute()` de abajo NO es un re-invoke "a
    // mano porque sí": ES esa re-entrega real (misma deliveryId + mismo payload), que ahora sí
    // encuentra la fila y marca `failed` + vista.
    it('F4-bis: message_updated antes que message_created RECHAZA (retriable); el reintento de Chatwoot (mismo evento, tras el eco message_created) marca failed + vista', async () => {
      const { uc, conversationRepo, messageRepo, deliveryRepo } = makeUseCase();
      const chatwootRetry = {
        event: 'message_updated',
        id: 555,
        content_attributes: { external_error: 'Template not found' },
      };

      // 1er intento: la fila NO existe todavía → RECHAZA → la ruta real respondería 500
      await expect(uc.execute('d-mu-order', chatwootRetry)).rejects.toThrow(/fila 555 aún no espejada/);
      expect(await deliveryRepo.hasSeen('chatwoot', 'd-mu-order')).toBe(false); // NO vista

      // el eco message_created (async, en vuelo) crea la fila
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 920, status: 'open' });
      await messageRepo.upsertByChatwootMessageId({
        conversationId: conv.id,
        chatwootMessageId: 555,
        direction: 'outbound',
        content: 'Hola',
        chatwootCreatedAt: new Date().toISOString(),
      });

      // Chatwoot reintenta EL MISMO evento (misma deliveryId, mismo payload) tras el 500 anterior
      await expect(uc.execute('d-mu-order', chatwootRetry)).resolves.toBeUndefined();
      expect(await deliveryRepo.hasSeen('chatwoot', 'd-mu-order')).toBe(true); // ahora sí vista

      const messages = await messageRepo.listByConversation(conv.id);
      expect(messages[0]!.deliveryStatus).toBe('failed');
    });

    // F4-bis (re-review) — CORRIGE el test invertido del F4 original: ANTES de F4 este test
    // afirmaba (correctamente) `hasSeen===true` porque `handleMessageUpdated` tragaba el error;
    // F4 lo invirtió a `hasSeen===false` con `.resolves.toBeUndefined()` (fail-open sin lanzar) —
    // un mecanismo que NUNCA generaba el retry real (la ruta responde 200 sin importar el
    // boolean). El contrato correcto: un repo-error transitorio RECHAZA (simetría ROB-2 con
    // `handleMessageCreated`, que ya dejaba propagar sus propios errores de repo).
    it('F4-bis: repo error transitorio en markDeliveryFailedByChatwootMessageId RECHAZA (ROB-2) y la delivery NO queda vista', async () => {
      class ThrowingMessageRepo extends InMemoryChatMessageRepository {
        override async markDeliveryFailedByChatwootMessageId(): Promise<never> {
          throw new Error('db hipo');
        }
      }
      const conversationRepo = new InMemoryConversationRepository();
      const messageRepo = new ThrowingMessageRepo();
      const deliveryRepo = new InMemoryWebhookDeliveryRepository();
      const uc = new ReceiveChatwootWebhook(conversationRepo, messageRepo, deliveryRepo);

      await expect(
        uc.execute('d-mu-5', { event: 'message_updated', id: 1, content_attributes: { external_error: 'boom' } }),
      ).rejects.toThrow('db hipo');

      // RECHAZA → la ruta real respondería 500 → Chatwoot reintenta; la delivery NO queda vista
      expect(await deliveryRepo.hasSeen('chatwoot', 'd-mu-5')).toBe(false);
    });
  });
});
