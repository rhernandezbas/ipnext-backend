/**
 * messaging-inbox (F1, batch B4) — SendMessage (SEND-1/2/3). `canReply` is read
 * straight from the mirror (cached by the last GetConversation/webhook) — NEVER
 * recomputed with local 24h math (design §4, decision confirmed by the user).
 * Uses `FakeChatwootGateway` (helpers/) instead of mocking axios/Prisma.
 *
 * messaging-inbox-v2-media (F1.5 fase A, Tanda 2 · SEND-1/4/5/7/8) — extended with
 * OPTIONAL `files`. In-memory `ChatMessageAttachmentRepository` (never mock Prisma
 * directly — CLAUDE.md convention).
 *
 * fix-be #1 (CRÍTICO, re-diseño) — SEND-5 ya NO alinea `sent.attachments[i]`
 * posicionalmente con `files[i]` ni escribe un buffer local a `FileStorage`: cada
 * fila se crea `pending` con la metadata de CHATWOOT y dispara
 * `ChatMediaDownloadTrigger.requestDownload` (mismo patrón que
 * `ReceiveChatwootWebhook`/`GetConversation`). El harness usa un trigger FAKE que
 * solo REGISTRA la llamada — no baja nada de verdad (eso es responsabilidad de
 * `DownloadChatMessageAttachment`, testeado aparte).
 */
import { SendMessage } from '@application/use-cases/messaging/SendMessage';
import { MessagingWindowExpiredError, ChatwootUnavailableError, ConversationNotFoundError } from '@domain/errors/messaging';
import { AttachmentTooLargeError, UnsupportedAttachmentTypeError } from '@domain/errors/chatAttachment';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryChatMessageAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageAttachmentRepository';
import { FakeChatwootGateway } from '../../helpers/FakeChatwootGateway';
import type { ChatMediaDownloadTrigger } from '@domain/ports/ChatMediaDownloadTrigger';

function makeFakeTrigger() {
  const requestedDownloads: string[] = [];
  const downloadTrigger: ChatMediaDownloadTrigger = {
    requestDownload: (id: string) => {
      requestedDownloads.push(id);
    },
  };
  return { downloadTrigger, requestedDownloads };
}

function makeHarness() {
  const conversationRepo = new InMemoryConversationRepository();
  const messageRepo = new InMemoryChatMessageRepository();
  const gateway = new FakeChatwootGateway();
  const attachmentRepo = new InMemoryChatMessageAttachmentRepository();
  const { downloadTrigger, requestedDownloads } = makeFakeTrigger();
  const uc = new SendMessage(conversationRepo, messageRepo, gateway, attachmentRepo, downloadTrigger);
  return { conversationRepo, messageRepo, gateway, attachmentRepo, downloadTrigger, requestedDownloads, uc };
}

describe('SendMessage', () => {
  it('SEND-1: canReply=true → calls Chatwoot, upserts the outbound ChatMessage and Conversation preview', async () => {
    const { conversationRepo, messageRepo, gateway, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 5, canReply: true });
    gateway.sendMessageResult = {
      id: 900,
      direction: 'outbound',
      content: 'Hola, en que te ayudo?',
      senderName: 'Agente',
      createdAt: '2026-07-11T12:00:00.000Z',
    };

    const result = await uc.execute(conv.id, 'Hola, en que te ayudo?');

    expect(result).toEqual(
      expect.objectContaining({ direction: 'outbound', content: 'Hola, en que te ayudo?' }),
    );
    expect(gateway.sendMessageCalls).toEqual([{ chatwootConversationId: 5, content: 'Hola, en que te ayudo?' }]);

    const messages = await messageRepo.listByConversation(conv.id);
    expect(messages).toHaveLength(1);

    const updatedConv = await conversationRepo.findById(conv.id);
    expect(updatedConv!.lastMessagePreview).toBe('Hola, en que te ayudo?');
  });

  describe('SEND-2 — fuera de ventana', () => {
    it('canReply=false → 422 MessagingWindowExpiredError WITHOUT calling Chatwoot nor touching the mirror', async () => {
      const { conversationRepo, messageRepo, gateway, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 6, canReply: false });

      await expect(uc.execute(conv.id, 'tarde')).rejects.toBeInstanceOf(MessagingWindowExpiredError);

      expect(gateway.sendMessageCalls).toHaveLength(0);
      const messages = await messageRepo.listByConversation(conv.id);
      expect(messages).toHaveLength(0);
    });

    it('a conversation that never had an inbound message defaults canReply=false → 422', async () => {
      const { conversationRepo, gateway, uc } = makeHarness();
      // canReply defaults to false on create (schema default, design §1) — never set explicitly.
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 7 });

      await expect(uc.execute(conv.id, 'hola?')).rejects.toBeInstanceOf(MessagingWindowExpiredError);
      expect(gateway.sendMessageCalls).toHaveLength(0);
    });

    it('#1 canReply=false + un archivo GIGANTE en el lote → 422 SIN validar files ni llamar a Chatwoot (SEND-1 guard order: 2 antes que 3)', async () => {
      const { conversationRepo, gateway, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 19, canReply: false });
      const hugeFile = { buffer: Buffer.alloc(6 * 1024 * 1024), filename: 'big.jpg', contentType: 'image/jpeg' }; // 6MB > 5MB image ceiling

      await expect(uc.execute(conv.id, 'tarde', [hugeFile])).rejects.toBeInstanceOf(MessagingWindowExpiredError);

      expect(gateway.sendMessageCalls).toHaveLength(0);
    });
  });

  it('SEND-3: Chatwoot unreachable while sending → 503 ChatwootUnavailableError, no upsert', async () => {
    const { conversationRepo, messageRepo, gateway, uc } = makeHarness();
    gateway.failSendMessage = true;
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 8, canReply: true });

    await expect(uc.execute(conv.id, 'hola')).rejects.toBeInstanceOf(ChatwootUnavailableError);

    const messages = await messageRepo.listByConversation(conv.id);
    expect(messages).toHaveLength(0);
    const updatedConv = await conversationRepo.findById(conv.id);
    expect(updatedConv!.lastMessagePreview).toBeNull();
  });

  it('#2 throws ConversationNotFoundError for an unknown conversation id, con o sin files', async () => {
    const { uc } = makeHarness();

    await expect(uc.execute('ghost-id', 'hola')).rejects.toBeInstanceOf(ConversationNotFoundError);
    await expect(
      uc.execute('ghost-id', 'hola', [{ buffer: Buffer.from('x'), filename: 'a.txt', contentType: 'text/plain' }]),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  describe('messaging-inbox-v2-media (Tanda 2) — enviar adjuntos (SEND-1/4/5/7/8)', () => {
    it('#3 archivo con contentType vacío/no clasificable → 415 UnsupportedAttachmentTypeError, lote completo rechazado, gateway NUNCA llamado', async () => {
      const { conversationRepo, gateway, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 20, canReply: true });
      const files = [
        { buffer: Buffer.from('a'), filename: 'a.jpg', contentType: 'image/jpeg' },
        { buffer: Buffer.from('b'), filename: 'b', contentType: '' },
        { buffer: Buffer.from('c'), filename: 'c.mp3', contentType: 'audio/mpeg' },
      ];

      await expect(uc.execute(conv.id, 'x', files)).rejects.toBeInstanceOf(UnsupportedAttachmentTypeError);
      expect(gateway.sendMessageCalls).toHaveLength(0);
    });

    it('#4 archivo image de 6MB excede su límite (5MB) → 413 AttachmentTooLargeError, lote completo rechazado', async () => {
      const { conversationRepo, gateway, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 21, canReply: true });
      const files = [{ buffer: Buffer.alloc(6 * 1024 * 1024), filename: 'big.jpg', contentType: 'image/jpeg' }];

      await expect(uc.execute(conv.id, 'x', files)).rejects.toBeInstanceOf(AttachmentTooLargeError);
      expect(gateway.sendMessageCalls).toHaveLength(0);
    });

    it('#5 Chatwoot inalcanzable con files → 503, nada persistido (ni ChatMessage ni ChatMessageAttachment), download NUNCA disparado', async () => {
      const { conversationRepo, messageRepo, gateway, attachmentRepo, requestedDownloads, uc } = makeHarness();
      gateway.failSendMessage = true;
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 22, canReply: true });
      const upsertSpy = jest.spyOn(attachmentRepo, 'upsertByChatwootAttachmentId');
      const files = [{ buffer: Buffer.from('x'), filename: 'a.jpg', contentType: 'image/jpeg' }];

      await expect(uc.execute(conv.id, 'hola', files)).rejects.toBeInstanceOf(ChatwootUnavailableError);

      expect(await messageRepo.listByConversation(conv.id)).toHaveLength(0);
      expect(upsertSpy).not.toHaveBeenCalled();
      expect(requestedDownloads).toHaveLength(0);
    });

    it('#6 Chatwoot OK → la fila se crea `pending` con la metadata de CHATWOOT (no la del archivo local) y dispara el download trigger por su propio id', async () => {
      const { conversationRepo, messageRepo, gateway, attachmentRepo, requestedDownloads, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 23, canReply: true });
      gateway.sendMessageResult = {
        id: 950,
        direction: 'outbound',
        content: 'mirá el plan',
        senderName: 'Agente',
        createdAt: '2026-07-11T12:00:00.000Z',
        attachments: [
          {
            id: 5001,
            fileType: 'image',
            contentType: 'image/jpeg',
            // Metadata DISTINTA de la del archivo local (`files[0]` abajo) a propósito:
            // prueba que la fila usa la de CHATWOOT, nunca la del origin.
            filename: 'chatwoot-name.jpg',
            sizeBytes: 12345,
            width: 100,
            height: 200,
            sourceUrl: 'https://chat.ipnext.com.ar/x/5001.jpg',
            thumbSourceUrl: 'https://chat.ipnext.com.ar/x/5001-thumb.jpg',
          },
        ],
      };
      const files = [{ buffer: Buffer.from('img-bytes'), filename: 'local-name.jpg', contentType: 'image/jpeg' }];

      const result = await uc.execute(conv.id, 'mirá el plan', files);

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]).toMatchObject({ fileType: 'image', status: 'pending' });
      const messages = await messageRepo.listByConversation(conv.id);
      const rows = await attachmentRepo.listByMessageIds([messages[0]!.id]);
      expect(rows[0]).toMatchObject({
        filename: 'chatwoot-name.jpg',
        sizeBytes: 12345,
        width: 100,
        height: 200,
        sourceUrl: 'https://chat.ipnext.com.ar/x/5001.jpg',
        thumbSourceUrl: 'https://chat.ipnext.com.ar/x/5001-thumb.jpg',
        status: 'pending',
      });
      expect(requestedDownloads).toEqual([result.attachments[0]!.id]); // trigger fired with the ROW's own id
    });

    it('fix-be #1 [CRÍTICO] — upsertByChatwootAttachmentId (Prisma) lanza dentro del loop → execute() NO propaga, el mensaje sale igual (SEND-8), esa fila queda ausente del DTO', async () => {
      const conversationRepo = new InMemoryConversationRepository();
      const messageRepo = new InMemoryChatMessageRepository();
      const gateway = new FakeChatwootGateway();
      class ThrowingAttachmentRepo extends InMemoryChatMessageAttachmentRepository {
        override async upsertByChatwootAttachmentId(): Promise<never> {
          throw new Error('db down (Prisma)');
        }
      }
      const attachmentRepo = new ThrowingAttachmentRepo();
      const { downloadTrigger, requestedDownloads } = makeFakeTrigger();
      const uc = new SendMessage(conversationRepo, messageRepo, gateway, attachmentRepo, downloadTrigger);
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 24, canReply: true });
      gateway.sendMessageResult = {
        id: 951,
        direction: 'outbound',
        content: '',
        senderName: null,
        createdAt: '2026-07-11T12:05:00.000Z',
        attachments: [
          {
            id: 5002,
            fileType: 'image',
            contentType: 'image/jpeg',
            filename: null,
            sizeBytes: 9,
            width: null,
            height: null,
            sourceUrl: 'https://chat.ipnext.com.ar/x/5002.jpg',
            thumbSourceUrl: null,
          },
        ],
      };
      const files = [{ buffer: Buffer.from('img-bytes'), filename: 'foto.jpg', contentType: 'image/jpeg' }];

      const result = await uc.execute(conv.id, '', files);

      expect(result.attachments).toHaveLength(0); // la fila que falló al mirrorear queda simplemente ausente
      const messages = await messageRepo.listByConversation(conv.id);
      expect(messages).toHaveLength(1); // el ChatMessage se upsertea igual (SEND-8) — el WhatsApp ya salió
      expect(requestedDownloads).toHaveLength(0); // nunca llega a disparar el trigger — el upsert falló antes
    });

    it('fix-be #1 [CRÍTICO] — Chatwoot DESCARTA un adjunto (sent.attachments.length < files enviados) → no se corrompe: solo se mirrorea lo que Chatwoot confirmó, se loguea el mismatch', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const { conversationRepo, messageRepo, gateway, attachmentRepo, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 25, canReply: true });
      // Se mandan 2 archivos, pero Chatwoot solo hace eco de 1 (descartó el 2do —
      // p.ej. un subtipo no soportado del lado de WhatsApp).
      gateway.sendMessageResult = {
        id: 952,
        direction: 'outbound',
        content: '',
        senderName: null,
        createdAt: '2026-07-11T12:10:00.000Z',
        attachments: [
          { id: 6001, fileType: 'image', contentType: 'image/jpeg', filename: 'foto.jpg', sizeBytes: 3, width: null, height: null, sourceUrl: 'https://x/6001.jpg', thumbSourceUrl: null },
        ],
      };
      const files = [
        { buffer: Buffer.from('img'), filename: 'foto.jpg', contentType: 'image/jpeg' },
        { buffer: Buffer.from('pdf'), filename: 'factura.pdf', contentType: 'application/pdf' },
      ];

      const result = await uc.execute(conv.id, '', files);

      expect(result.attachments).toHaveLength(1); // únicamente lo que Chatwoot realmente confirmó
      expect(result.attachments[0]).toMatchObject({ contentType: 'image/jpeg', fileType: 'image' });
      const messages = await messageRepo.listByConversation(conv.id);
      const rows = await attachmentRepo.listByMessageIds([messages[0]!.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sourceUrl).toBe('https://x/6001.jpg');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Chatwoot echoed a different attachment count than sent'),
        expect.objectContaining({ sentCount: 1, filesSentCount: 2 }),
      );
      consoleErrorSpy.mockRestore();
    });

    it('fix-be #1 [CRÍTICO] — Chatwoot devuelve los attachments en orden DISTINTO al enviado → cada fila baja de SU PROPIO sourceUrl (sin mezclar metadata por posición)', async () => {
      const { conversationRepo, messageRepo, gateway, attachmentRepo, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 26, canReply: true });
      // Se manda [foto.jpg, factura.pdf] pero Chatwoot devuelve el PDF primero (orden
      // invertido) — con la alineación posicional VIEJA, el pdf terminaría con la
      // metadata del jpg (o viceversa). Con el fix, cada fila usa SU sentAttachment.
      gateway.sendMessageResult = {
        id: 953,
        direction: 'outbound',
        content: '',
        senderName: null,
        createdAt: '2026-07-11T12:15:00.000Z',
        attachments: [
          { id: 7002, fileType: 'file', contentType: 'application/pdf', filename: 'factura.pdf', sizeBytes: 3, width: null, height: null, sourceUrl: 'https://x/7002.pdf', thumbSourceUrl: null },
          { id: 7001, fileType: 'image', contentType: 'image/jpeg', filename: 'foto.jpg', sizeBytes: 3, width: null, height: null, sourceUrl: 'https://x/7001.jpg', thumbSourceUrl: null },
        ],
      };
      const files = [
        { buffer: Buffer.from('img'), filename: 'foto.jpg', contentType: 'image/jpeg' },
        { buffer: Buffer.from('pdf'), filename: 'factura.pdf', contentType: 'application/pdf' },
      ];

      const result = await uc.execute(conv.id, '', files);

      expect(result.attachments).toHaveLength(2);
      const messages = await messageRepo.listByConversation(conv.id);
      const rows = await attachmentRepo.listByMessageIds([messages[0]!.id]);
      const byChatwootId = new Map(rows.map((r) => [r.chatwootAttachmentId, r]));
      expect(byChatwootId.get(7002)).toMatchObject({ contentType: 'application/pdf', sourceUrl: 'https://x/7002.pdf' });
      expect(byChatwootId.get(7001)).toMatchObject({ contentType: 'image/jpeg', sourceUrl: 'https://x/7001.jpg' });
    });

    it('#9 content + files (caption) — ambos válidos, llegan juntos al gateway', async () => {
      const { conversationRepo, gateway, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 26, canReply: true });
      const files = [{ buffer: Buffer.from('x'), filename: 'a.jpg', contentType: 'image/jpeg' }];

      await uc.execute(conv.id, 'mirá el plan', files);

      expect(gateway.sendMessageCalls[0]).toMatchObject({ chatwootConversationId: 26, content: 'mirá el plan', files: 1 });
    });

    it('#10 files sin content (content vacío) es válido', async () => {
      const { conversationRepo, gateway, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 27, canReply: true });
      const files = [{ buffer: Buffer.from('x'), filename: 'a.jpg', contentType: 'image/jpeg' }];

      const result = await uc.execute(conv.id, '', files);

      expect(result.content).toBe('');
      expect(gateway.sendMessageCalls).toHaveLength(1);
    });

    it('#16 DTO outbound con adjuntos no filtra sourceUrl/storageKey (mismo criterio no-leak que MEDIA-4)', async () => {
      const { conversationRepo, gateway, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 28, canReply: true });
      gateway.sendMessageResult = {
        id: 953,
        direction: 'outbound',
        content: '',
        senderName: null,
        createdAt: '2026-07-11T12:20:00.000Z',
        attachments: [
          { id: 7001, fileType: 'image', contentType: 'image/jpeg', filename: null, sizeBytes: 3, width: null, height: null, sourceUrl: 'https://x/7001.jpg', thumbSourceUrl: null },
        ],
      };
      const files = [{ buffer: Buffer.from('img'), filename: 'foto.jpg', contentType: 'image/jpeg' }];

      const result = await uc.execute(conv.id, '', files);

      const att = result.attachments[0] as unknown as Record<string, unknown>;
      expect(att['sourceUrl']).toBeUndefined();
      expect(att['storageKey']).toBeUndefined();
      expect(att).toMatchObject({ fileType: 'image', status: 'pending' });
      expect(att['url']).toEqual(expect.stringContaining('/api/messaging/attachments/'));
    });
  });

  describe('messaging-inbox-notes (F1.5 fase D, SEND-1 MODIFIED / NOTE-3/4) — nota privada (isPrivate)', () => {
    it('canReply=false + isPrivate=true → bypasea el guard de ventana (NO throw), llama a Chatwoot con private:true, upsertea isPrivate:true, y NO bumpea el preview', async () => {
      const { conversationRepo, messageRepo, gateway, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({
        chatwootConversationId: 40,
        canReply: false,
        lastMessageAt: '2026-07-01T00:00:00.000Z',
        lastMessagePreview: 'ultimo mensaje real',
      });
      gateway.sendMessageResult = {
        id: 970,
        direction: 'outbound',
        content: 'nota interna: revisar con soporte',
        senderName: 'Agente',
        createdAt: '2026-07-11T14:00:00.000Z',
      };

      const result = await uc.execute(conv.id, 'nota interna: revisar con soporte', [], true);

      expect(result.private).toBe(true);
      expect(gateway.sendMessageCalls).toEqual([
        expect.objectContaining({ chatwootConversationId: 40, content: 'nota interna: revisar con soporte', private: true }),
      ]);
      const messages = await messageRepo.listByConversation(conv.id);
      expect(messages[0]).toMatchObject({ isPrivate: true });
      const updatedConv = await conversationRepo.findById(conv.id);
      expect(updatedConv!.lastMessagePreview).toBe('ultimo mensaje real'); // NOT bumped
      expect(updatedConv!.lastMessageAt).toBe('2026-07-01T00:00:00.000Z'); // NOT bumped
    });

    it('isPrivate=true CON canReply=true (ventana abierta) también bloquea el bump de preview — el criterio NO depende de canReply', async () => {
      const { conversationRepo, messageRepo, gateway, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({
        chatwootConversationId: 41,
        canReply: true,
        lastMessageAt: '2026-07-01T00:00:00.000Z',
        lastMessagePreview: 'ultimo mensaje real',
      });
      gateway.sendMessageResult = {
        id: 971,
        direction: 'outbound',
        content: 'otra nota',
        senderName: 'Agente',
        createdAt: '2026-07-11T14:05:00.000Z',
      };

      await uc.execute(conv.id, 'otra nota', [], true);

      const updatedConv = await conversationRepo.findById(conv.id);
      expect(updatedConv!.lastMessagePreview).toBe('ultimo mensaje real');
      expect(updatedConv!.lastMessageAt).toBe('2026-07-01T00:00:00.000Z');
      const messages = await messageRepo.listByConversation(conv.id);
      expect(messages[0]).toMatchObject({ isPrivate: true });
    });

    it('isPrivate ausente/false (default) → comportamiento SEND-1 idéntico a hoy: preview bumpea, DTO trae private:false, gateway sin campo private', async () => {
      const { conversationRepo, gateway, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 42, canReply: true });
      gateway.sendMessageResult = {
        id: 972,
        direction: 'outbound',
        content: 'hola normal',
        senderName: 'Agente',
        createdAt: '2026-07-11T14:10:00.000Z',
      };

      const result = await uc.execute(conv.id, 'hola normal');

      expect(result.private).toBe(false);
      expect(gateway.sendMessageCalls).toEqual([
        expect.objectContaining({ chatwootConversationId: 42, content: 'hola normal' }),
      ]);
      expect(gateway.sendMessageCalls[0]!.private).toBeUndefined();
      const updatedConv = await conversationRepo.findById(conv.id);
      expect(updatedConv!.lastMessagePreview).toBe('hola normal'); // bump intact — cero regresión
    });

    it('canReply=false + isPrivate=false (explícito) → SIGUE dando 422 (el bypass es SOLO para notas, no cambia el reply normal)', async () => {
      const { conversationRepo, gateway, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 43, canReply: false });

      await expect(uc.execute(conv.id, 'tarde', [], false)).rejects.toBeInstanceOf(MessagingWindowExpiredError);
      expect(gateway.sendMessageCalls).toHaveLength(0);
    });
  });

  describe('messaging-inbox-polish (F1.5) — preview WhatsApp-style para el ÚLTIMO mensaje ENVIADO solo-media', () => {
    it('outbound solo-imagen (content vacío) → Conversation.lastMessagePreview = "📷 Imagen"', async () => {
      const { conversationRepo, gateway, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 30, canReply: true });
      gateway.sendMessageResult = {
        id: 960,
        direction: 'outbound',
        content: '',
        senderName: 'Agente',
        createdAt: '2026-07-11T12:30:00.000Z',
        attachments: [
          {
            id: 8001,
            fileType: 'image',
            contentType: 'image/jpeg',
            filename: 'foto.jpg',
            sizeBytes: 3,
            width: null,
            height: null,
            sourceUrl: 'https://x/8001.jpg',
            thumbSourceUrl: null,
          },
        ],
      };
      const files = [{ buffer: Buffer.from('img'), filename: 'foto.jpg', contentType: 'image/jpeg' }];

      await uc.execute(conv.id, '', files);

      const updatedConv = await conversationRepo.findById(conv.id);
      expect(updatedConv!.lastMessagePreview).toBe('📷 Imagen');
    });

    it('outbound con caption + adjunto → el preview usa el content (la caption manda, igual que en el inbound)', async () => {
      const { conversationRepo, gateway, uc } = makeHarness();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 31, canReply: true });
      gateway.sendMessageResult = {
        id: 961,
        direction: 'outbound',
        content: 'mirá el plan',
        senderName: 'Agente',
        createdAt: '2026-07-11T12:35:00.000Z',
        attachments: [
          {
            id: 8002,
            fileType: 'image',
            contentType: 'image/jpeg',
            filename: 'foto.jpg',
            sizeBytes: 3,
            width: null,
            height: null,
            sourceUrl: 'https://x/8002.jpg',
            thumbSourceUrl: null,
          },
        ],
      };
      const files = [{ buffer: Buffer.from('img'), filename: 'foto.jpg', contentType: 'image/jpeg' }];

      await uc.execute(conv.id, 'mirá el plan', files);

      const updatedConv = await conversationRepo.findById(conv.id);
      expect(updatedConv!.lastMessagePreview).toBe('mirá el plan');
    });
  });
});
