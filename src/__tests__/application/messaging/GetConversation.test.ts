/**
 * messaging-inbox (F1, batch B4) — GetConversation, fetch-on-open (INBOX-2 + CTX-2).
 * Composes ConversationRepository/ChatMessageRepository/ChatwootGateway/GetClientContextByPhone
 * (design §4 — the last one is injected as a collaborator use case, same pattern as
 * `CancelTv`'s `ClientTvCancellationRepository`/lookups). Uses `FakeChatwootGateway`.
 */
import { GetConversation } from '@application/use-cases/messaging/GetConversation';
import { GetClientContextByPhone } from '@application/use-cases/messaging/GetClientContextByPhone';
import { ConversationNotFoundError } from '@domain/errors/messaging';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryChatMessageAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageAttachmentRepository';
import { FakeChatwootGateway } from '../../helpers/FakeChatwootGateway';
import type { CustomerRepository, ActiveClientContact } from '@domain/ports/CustomerRepository';
import type { ChatMediaDownloadTrigger } from '@domain/ports/ChatMediaDownloadTrigger';

function makeCustomerRepo(contacts: ActiveClientContact[] = []): CustomerRepository {
  return { listActiveContacts: jest.fn().mockResolvedValue(contacts) } as unknown as CustomerRepository;
}

describe('GetConversation (fetch-on-open)', () => {
  it('INBOX-2: syncs fresh messages from Chatwoot, upserts idempotently, and returns them in the response', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const gateway = new FakeChatwootGateway();
    const getClientContext = new GetClientContextByPhone(makeCustomerRepo());

    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 20,
      contactPhone: '+5492324000020',
      canReply: false,
      status: 'open',
    });

    gateway.conversationsById.set(20, {
      id: 20,
      contactName: 'Cliente Fresco',
      contactPhone: '+5492324000020',
      status: 'open',
      canReply: true,
      lastActivityAt: '2026-07-11T12:00:00.000Z',
    });
    gateway.messagesById.set(20, [
      {
        id: 1001,
        direction: 'inbound',
        content: 'Mensaje nuevo que faltaba',
        senderName: 'Cliente',
        createdAt: '2026-07-11T12:00:00.000Z',
      },
    ]);

    const uc = new GetConversation(conversationRepo, messageRepo, gateway, getClientContext);
    const result = await uc.execute(conv.id);

    expect(result.canReply).toBe(true);
    expect(result.contactName).toBe('Cliente Fresco');

    const messages = await messageRepo.listByConversation(conv.id);
    expect(messages).toEqual([
      expect.objectContaining({ chatwootMessageId: 1001, content: 'Mensaje nuevo que faltaba' }),
    ]);
  });

  it('INBOX-2: re-processing the same live message via sync stays idempotent by chatwootMessageId', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const gateway = new FakeChatwootGateway();
    const getClientContext = new GetClientContextByPhone(makeCustomerRepo());
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 21 });

    gateway.conversationsById.set(21, {
      id: 21, contactName: null, contactPhone: null, status: 'open', canReply: true, lastActivityAt: null,
    });
    gateway.messagesById.set(21, [
      { id: 55, direction: 'inbound', content: 'msg', senderName: null, createdAt: '2026-07-11T09:00:00.000Z' },
    ]);

    const uc = new GetConversation(conversationRepo, messageRepo, gateway, getClientContext);
    await uc.execute(conv.id);
    await uc.execute(conv.id); // second fetch-on-open, same live message

    const messages = await messageRepo.listByConversation(conv.id);
    expect(messages).toHaveLength(1);
  });

  it('INBOX-2: Chatwoot down during fetch-on-open → swallows the failure, serves the mirror snapshot, never throws', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const gateway = new FakeChatwootGateway();
    gateway.failGetConversation = true;
    const getClientContext = new GetClientContextByPhone(makeCustomerRepo());

    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 22,
      contactName: 'Cliente Stale',
      canReply: true,
      status: 'open',
      lastMessagePreview: 'ultimo conocido',
    });

    const uc = new GetConversation(conversationRepo, messageRepo, gateway, getClientContext);
    const result = await uc.execute(conv.id);

    expect(result.contactName).toBe('Cliente Stale');
    expect(result.preview).toBe('ultimo conocido');
    expect(result.canReply).toBe(true); // unchanged — sync never got to persist anything
  });

  it('INBOX-2: an unknown conversation id responds 404 (ConversationNotFoundError)', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const gateway = new FakeChatwootGateway();
    const getClientContext = new GetClientContextByPhone(makeCustomerRepo());
    const uc = new GetConversation(conversationRepo, messageRepo, gateway, getClientContext);

    await expect(uc.execute('ghost-id')).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it('H3: fetch-on-open cuyo GET no trae phone/lastActivity (undefined, no null) NO pisa esos campos en el mirror — la conversacion no cae al fondo del inbox', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const gateway = new FakeChatwootGateway();
    const getClientContext = new GetClientContextByPhone(makeCustomerRepo());

    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 30,
      contactPhone: '+5492324000030',
      lastMessageAt: '2026-07-01T00:00:00.000Z',
      status: 'open',
    });

    gateway.conversationsById.set(30, {
      id: 30,
      // contactName/contactPhone/lastActivityAt intentionally OMITTED — mirrors what
      // the real HttpChatwootGateway mapper now emits (`undefined`, never `null`) for
      // genuinely absent GET response fields (H3).
      status: 'open',
      canReply: true,
    });
    gateway.messagesById.set(30, []);

    const uc = new GetConversation(conversationRepo, messageRepo, gateway, getClientContext);
    const result = await uc.execute(conv.id);

    expect(result.contactPhone).toBe('+5492324000030'); // untouched, NOT wiped to null
    expect(result.lastMessageAt).toBe('2026-07-01T00:00:00.000Z'); // untouched
  });

  it('H2 residual — fetch-on-open NO persiste una nota privada de agente (message_type outbound + private:true) aunque el GET la traiga', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const gateway = new FakeChatwootGateway();
    const getClientContext = new GetClientContextByPhone(makeCustomerRepo());

    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 40 });

    gateway.conversationsById.set(40, {
      id: 40, contactName: null, contactPhone: null, status: 'open', canReply: true, lastActivityAt: null,
    });
    gateway.messagesById.set(40, [
      {
        id: 4001,
        direction: 'outbound',
        content: 'nota interna: revisar con soporte',
        senderName: 'Agente',
        createdAt: '2026-07-11T13:00:00.000Z',
        private: true,
      },
    ]);

    const uc = new GetConversation(conversationRepo, messageRepo, gateway, getClientContext);
    await uc.execute(conv.id);

    const messages = await messageRepo.listByConversation(conv.id);
    expect(messages).toEqual([]); // hoy se persiste como un mensaje outbound normal (leak)
  });

  it('CTX-2 + composition: returns clientContext computed from the (possibly refreshed) contactPhone, without mutating the client', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const gateway = new FakeChatwootGateway();
    gateway.failGetConversation = true; // sync fails — context must use the STALE mirror phone
    const activeContact: ActiveClientContact = { id: 'c1', name: 'Juan Perez', phone: '+5492324421234', email: null };
    const customerRepo = makeCustomerRepo([activeContact]);
    const getClientContext = new GetClientContextByPhone(customerRepo);

    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 23,
      contactPhone: '02324 421234',
      canReply: true,
    });

    const uc = new GetConversation(conversationRepo, messageRepo, gateway, getClientContext);
    const result = await uc.execute(conv.id);

    expect(result.clientContext).toEqual({
      status: 'matched',
      clients: [{ id: 'c1', name: 'Juan Perez', status: 'active' }],
    });
    expect(customerRepo.listActiveContacts).toHaveBeenCalledTimes(1); // ONE call per detail read, no N+1
  });

  describe('MEDIA-1 scenario 5 — fetch-on-open también captura adjuntos (paridad con el webhook)', () => {
    it('un mensaje traído por el GET con attachments genera una fila ChatMessageAttachment pending', async () => {
      const conversationRepo = new InMemoryConversationRepository();
      const messageRepo = new InMemoryChatMessageRepository();
      const attachmentRepo = new InMemoryChatMessageAttachmentRepository();
      const gateway = new FakeChatwootGateway();
      const getClientContext = new GetClientContextByPhone(makeCustomerRepo());

      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 50 });
      gateway.conversationsById.set(50, {
        id: 50, contactName: null, contactPhone: null, status: 'open', canReply: true, lastActivityAt: null,
      });
      gateway.messagesById.set(50, [
        {
          id: 5001,
          direction: 'inbound',
          content: '',
          senderName: 'Cliente',
          createdAt: '2026-07-11T14:00:00.000Z',
          attachments: [
            {
              id: 88,
              fileType: 'image',
              contentType: 'image/jpeg',
              filename: null,
              sizeBytes: 5000,
              width: 400,
              height: 300,
              sourceUrl: 'https://chat.ipnext.com.ar/x/88.jpg',
              thumbSourceUrl: 'https://chat.ipnext.com.ar/x/88-thumb.jpg',
            },
          ],
        },
      ]);

      const uc = new GetConversation(conversationRepo, messageRepo, gateway, getClientContext, attachmentRepo);
      await uc.execute(conv.id);

      const messages = await messageRepo.listByConversation(conv.id);
      const rows = await attachmentRepo.listByMessageIds([messages[0]!.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.chatwootAttachmentId).toBe(88);
      expect(rows[0]!.status).toBe('pending');
    });

    it('re-fetch-on-open sobre el mismo mensaje/adjunto no duplica la fila (idempotencia también acá)', async () => {
      const conversationRepo = new InMemoryConversationRepository();
      const messageRepo = new InMemoryChatMessageRepository();
      const attachmentRepo = new InMemoryChatMessageAttachmentRepository();
      const gateway = new FakeChatwootGateway();
      const getClientContext = new GetClientContextByPhone(makeCustomerRepo());

      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 51 });
      gateway.conversationsById.set(51, {
        id: 51, contactName: null, contactPhone: null, status: 'open', canReply: true, lastActivityAt: null,
      });
      gateway.messagesById.set(51, [
        {
          id: 5101,
          direction: 'inbound',
          content: '',
          createdAt: '2026-07-11T14:00:00.000Z',
          senderName: null,
          attachments: [
            { id: 89, fileType: 'file', contentType: 'application/pdf', filename: null, sizeBytes: 1000, width: null, height: null, sourceUrl: 'https://x/89.pdf', thumbSourceUrl: null },
          ],
        },
      ]);

      const uc = new GetConversation(conversationRepo, messageRepo, gateway, getClientContext, attachmentRepo);
      await uc.execute(conv.id);
      await uc.execute(conv.id);

      const messages = await messageRepo.listByConversation(conv.id);
      const rows = await attachmentRepo.listByMessageIds([messages[0]!.id]);
      expect(rows).toHaveLength(1);
    });
  });

  describe('fix-be #7 (BAJO) — aislación del trigger también en fetch-on-open (paridad con ReceiveChatwootWebhook scenario 24)', () => {
    it('requestDownload lanza SÍNCRONO en el primer mensaje con adjunto → NO dropea la persistencia del resto de los mensajes del mismo sync', async () => {
      const conversationRepo = new InMemoryConversationRepository();
      const messageRepo = new InMemoryChatMessageRepository();
      const attachmentRepo = new InMemoryChatMessageAttachmentRepository();
      const gateway = new FakeChatwootGateway();
      const getClientContext = new GetClientContextByPhone(makeCustomerRepo());
      const throwingTrigger: ChatMediaDownloadTrigger = {
        requestDownload: () => {
          throw new Error('boom - infra bug en el trigger');
        },
      };

      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 60 });
      gateway.conversationsById.set(60, {
        id: 60, contactName: null, contactPhone: null, status: 'open', canReply: true, lastActivityAt: null,
      });
      gateway.messagesById.set(60, [
        {
          id: 6001,
          direction: 'inbound',
          content: '',
          senderName: 'Cliente',
          createdAt: '2026-07-11T15:00:00.000Z',
          attachments: [
            {
              id: 90, fileType: 'image', contentType: 'image/jpeg', filename: null, sizeBytes: 1000,
              width: null, height: null, sourceUrl: 'https://x/90.jpg', thumbSourceUrl: null,
            },
          ],
        },
        {
          id: 6002,
          direction: 'inbound',
          content: 'segundo mensaje sin adjunto, del MISMO sync',
          senderName: 'Cliente',
          createdAt: '2026-07-11T15:01:00.000Z',
        },
      ]);

      const uc = new GetConversation(conversationRepo, messageRepo, gateway, getClientContext, attachmentRepo, throwingTrigger);
      await uc.execute(conv.id);

      const messages = await messageRepo.listByConversation(conv.id);
      // Ambos mensajes persistidos — el throw síncrono del trigger en el PRIMERO no
      // interrumpió el loop de sync del SEGUNDO.
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.content)).toContain('segundo mensaje sin adjunto, del MISMO sync');

      // Y el adjunto del primer mensaje SÍ quedó capturado (pending) pese al throw del trigger.
      const rows = await attachmentRepo.listByMessageIds([messages[0]!.id, messages[1]!.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('pending');
    });
  });
});
