import { ChatMessageThreadReader } from '@infrastructure/adapters/assistant/ChatMessageThreadReader';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryChatMessageAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageAttachmentRepository';

/**
 * ai-assistant-cobranzas (4.6 + 4.11 / D4-SEC-6 / D11-DAT-4) — las DOS señales que el motor
 * necesita del hilo y que hasta ahora eran placeholders.
 *
 * `generatedByAssistant` alimenta la guarda "un agente humano ya está atendiendo" (SEC-6). El
 * error caro NO es marcar de menos: es marcar de MÁS. Si un mensaje de un humano se etiquetara
 * como "lo escribió el bot", la guarda no dispara y el asistente le habla ENCIMA a un agente
 * que está en el medio de una conversación. Por eso la derivación es por lista blanca
 * explícita de remitentes del bot: todo lo que no está en la lista cuenta como humano.
 *
 * `attachmentFilenames` alimenta la excepción del pre-chequeo del comprobante (D11): sin el
 * `filename` del adjunto, `comprobante_<op>.pdf` es invisible y `promesa_pago` gana una
 * conversación que en realidad traía un pago hecho.
 */
describe('ChatMessageThreadReader', () => {
  async function seed() {
    const messages = new InMemoryChatMessageRepository();
    const attachments = new InMemoryChatMessageAttachmentRepository();

    const inbound = await messages.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 1,
      direction: 'inbound',
      content: 'te paso el comprobante',
      senderName: 'Juan Pérez',
      chatwootCreatedAt: '2026-09-04T10:00:00.000Z',
    });
    const botReply = await messages.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 2,
      direction: 'outbound',
      content: 'Recibimos tu pago.',
      senderName: 'Prominense Bot',
      chatwootCreatedAt: '2026-09-04T10:00:10.000Z',
    });
    const humanReply = await messages.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 3,
      direction: 'outbound',
      content: 'Hola, soy Vanesa de Administración.',
      senderName: 'Vanesa',
      chatwootCreatedAt: '2026-09-04T10:01:00.000Z',
    });

    await attachments.upsertByChatwootAttachmentId({
      messageId: inbound.id,
      chatwootAttachmentId: 10,
      fileType: 'file',
      contentType: 'application/pdf',
      filename: 'comprobante_177332834792.pdf',
      sourceUrl: 'https://chatwoot.example/att/10',
    });

    return { messages, attachments, ids: { inbound: inbound.id, botReply: botReply.id, humanReply: humanReply.id } };
  }

  it('4.6 — marca `generatedByAssistant` sólo en los remitentes declarados del bot', async () => {
    const { messages, attachments } = await seed();

    const turns = await new ChatMessageThreadReader(messages, attachments, {
      assistantSenderNames: ['Prominense Bot'],
    }).readRecentTurns('conv-1', 20);

    expect(turns.map((t) => [t.role, t.generatedByAssistant])).toEqual([
      ['customer', false],
      ['agent', true], // el bot
      ['agent', false], // Vanesa, humana — la que SEC-6 tiene que respetar
    ]);
  });

  it('4.6 — el mensaje del CLIENTE nunca se marca como generado por el asistente', async () => {
    const { messages, attachments } = await seed();

    const turns = await new ChatMessageThreadReader(messages, attachments, {
      // Config patológica: alguien pone el nombre del cliente en la lista.
      assistantSenderNames: ['Juan Pérez'],
    }).readRecentTurns('conv-1', 20);

    expect(turns[0].role).toBe('customer');
    expect(turns[0].generatedByAssistant).toBe(false);
  });

  it('SEC-6 — sin lista configurada, TODO saliente cuenta como humano (lado seguro)', async () => {
    const { messages, attachments } = await seed();

    const turns = await new ChatMessageThreadReader(messages, attachments).readRecentTurns('conv-1', 20);

    // Marcar de menos hace al motor MÁS cauto (calla); marcar de más lo haría hablar
    // encima de un agente. El default cae siempre del primer lado.
    expect(turns.filter((t) => t.generatedByAssistant)).toHaveLength(0);
  });

  it('4.11 — `attachmentFilenames` trae el nombre del adjunto del mensaje', async () => {
    const { messages, attachments } = await seed();

    const turns = await new ChatMessageThreadReader(messages, attachments).readRecentTurns('conv-1', 20);

    expect(turns[0].attachmentFilenames).toEqual(['comprobante_177332834792.pdf']);
  });

  it('4.11 — mensaje sin adjuntos ⇒ `[]`', async () => {
    const { messages, attachments } = await seed();

    const turns = await new ChatMessageThreadReader(messages, attachments).readRecentTurns('conv-1', 20);

    expect(turns[1].attachmentFilenames).toEqual([]);
    expect(turns[2].attachmentFilenames).toEqual([]);
  });

  it('4.11 — sin repo de adjuntos el hilo sigue funcionando (`[]`, nunca una excepción)', async () => {
    const { messages } = await seed();

    const turns = await new ChatMessageThreadReader(messages).readRecentTurns('conv-1', 20);

    expect(turns).toHaveLength(3);
    expect(turns.every((t) => t.attachmentFilenames.length === 0)).toBe(true);
  });

  it('4.11 — un solo listado de adjuntos para TODO el hilo (sin N+1)', async () => {
    const { messages, attachments } = await seed();
    const spy = jest.spyOn(attachments, 'listByMessageIds');

    await new ChatMessageThreadReader(messages, attachments).readRecentTurns('conv-1', 20);

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/**
 * ═══ FIX WAVE W1 ════════════════════════════════════════════════════════════
 *
 * SEC-6 pasó a ser una VENTANA (¿hay un humano atendiendo AHORA?) y no un ordenamiento de
 * turnos. Sin `at` en los turnos, la guarda no puede evaluar ninguna ventana — y como el lado
 * seguro es "sin timestamp ⇒ activo", un reader que no lo emita deja al bot mudo para siempre.
 */
describe('ChatMessageThreadReader — W1: el turno lleva su timestamp', () => {
  it('W1: cada turno emite `at` con el `createdAt` del mensaje espejado', async () => {
    const messages = new InMemoryChatMessageRepository();
    const guardado = await messages.upsertByChatwootMessageId({
      conversationId: 'conv-w1',
      chatwootMessageId: 99,
      direction: 'inbound',
      content: 'hola',
      senderName: 'Juan Pérez',
      chatwootCreatedAt: '2026-09-04T10:00:00.000Z',
    });

    const turns = await new ChatMessageThreadReader(messages).readRecentTurns('conv-w1', 20);

    expect(turns).toHaveLength(1);
    expect(turns[0].at).toBe(guardado.createdAt);
    expect(typeof turns[0].at).toBe('string');
  });
});
