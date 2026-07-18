/**
 * inbox-views (Ola 1, VIEW-1) — filtro "Sin atender": conversación NO-resuelta cuyo
 * ÚLTIMO mensaje NO-privado es `inbound` (el cliente habló último y ningún agente
 * respondió por WhatsApp; una nota interna NO cuenta como atención). La semántica
 * vive en el adapter vía el cache desnormalizado `lastPublicMessageDirection`,
 * mantenido por los write-paths de `ChatMessageRepository` (choke point: TODO
 * mensaje entra por ahí — webhook/fetch-on-open/send/bulk/template). Naming espejo
 * de `ListConversations.statusFilter.test.ts`.
 */
import { ListConversations } from '@application/use-cases/messaging/ListConversations';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';

function buildRepos() {
  const conversationRepo = new InMemoryConversationRepository();
  const messageRepo = new InMemoryChatMessageRepository();
  // Espejo del wiring real: el adapter Prisma de ChatMessage SIEMPRE mantiene el
  // cache en Conversation; in-memory lo hace vía este link explícito.
  messageRepo.linkConversationRepo(conversationRepo);
  return { conversationRepo, messageRepo, uc: new ListConversations(conversationRepo) };
}

describe('ListConversations — vista Sin atender (inbox-views VIEW-1)', () => {
  it('cliente habló último (inbound) → entra; agente respondió último (outbound) → sale', async () => {
    const { conversationRepo, messageRepo, uc } = buildRepos();

    const unattended = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 1,
      contactName: 'Cliente sin respuesta',
      lastMessageAt: '2026-07-15T10:00:00.000Z',
    });
    await messageRepo.upsertByChatwootMessageId({
      conversationId: unattended.id,
      chatwootMessageId: 100,
      direction: 'inbound',
      content: 'hola, no tengo internet',
      chatwootCreatedAt: '2026-07-15T10:00:00.000Z',
    });

    const attended = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 2,
      contactName: 'Cliente respondido',
      lastMessageAt: '2026-07-15T11:00:00.000Z',
    });
    await messageRepo.upsertByChatwootMessageId({
      conversationId: attended.id,
      chatwootMessageId: 200,
      direction: 'inbound',
      content: 'buenas',
      chatwootCreatedAt: '2026-07-15T10:30:00.000Z',
    });
    await messageRepo.upsertByChatwootMessageId({
      conversationId: attended.id,
      chatwootMessageId: 201,
      direction: 'outbound',
      content: 'hola! ya lo revisamos',
      chatwootCreatedAt: '2026-07-15T11:00:00.000Z',
    });

    const result = await uc.execute({ unattended: true });

    expect(result.data.map((d) => d.id)).toEqual([unattended.id]);
    expect(result.total).toBe(1);
  });

  it('el agente responde DESPUÉS → la conversación sale del bucket (transición)', async () => {
    const { conversationRepo, messageRepo, uc } = buildRepos();

    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 1,
      lastMessageAt: '2026-07-15T10:00:00.000Z',
    });
    await messageRepo.upsertByChatwootMessageId({
      conversationId: conv.id,
      chatwootMessageId: 100,
      direction: 'inbound',
      content: 'sigo sin señal',
      chatwootCreatedAt: '2026-07-15T10:00:00.000Z',
    });

    const before = await uc.execute({ unattended: true });
    expect(before.total).toBe(1);

    await messageRepo.upsertByChatwootMessageId({
      conversationId: conv.id,
      chatwootMessageId: 101,
      direction: 'outbound',
      content: 'te mandamos un técnico',
      chatwootCreatedAt: '2026-07-15T10:05:00.000Z',
    });

    const after = await uc.execute({ unattended: true });
    expect(after.total).toBe(0);
  });

  it('una nota interna (isPrivate) posterior al cliente NO atiende — sigue Sin atender', async () => {
    const { conversationRepo, messageRepo, uc } = buildRepos();

    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 1,
      lastMessageAt: '2026-07-15T10:00:00.000Z',
    });
    await messageRepo.upsertByChatwootMessageId({
      conversationId: conv.id,
      chatwootMessageId: 100,
      direction: 'inbound',
      content: 'necesito el técnico',
      chatwootCreatedAt: '2026-07-15T10:00:00.000Z',
    });
    // Nota interna del agente, POSTERIOR — jamás cruza a WhatsApp, no atiende.
    await messageRepo.upsertByChatwootMessageId({
      conversationId: conv.id,
      chatwootMessageId: 101,
      direction: 'outbound',
      content: 'ojo: cliente moroso, verificar saldo antes',
      chatwootCreatedAt: '2026-07-15T10:10:00.000Z',
      isPrivate: true,
    });

    const result = await uc.execute({ unattended: true });

    expect(result.data.map((d) => d.id)).toEqual([conv.id]);
    expect(result.total).toBe(1);
  });

  it('resuelta queda FUERA aunque el último mensaje público sea inbound', async () => {
    const { conversationRepo, messageRepo, uc } = buildRepos();

    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 1,
      status: 'resolved',
      lastMessageAt: '2026-07-15T10:00:00.000Z',
    });
    await messageRepo.upsertByChatwootMessageId({
      conversationId: conv.id,
      chatwootMessageId: 100,
      direction: 'inbound',
      content: 'gracias!',
      chatwootCreatedAt: '2026-07-15T10:00:00.000Z',
    });

    const result = await uc.execute({ unattended: true });

    expect(result.total).toBe(0);
  });

  it('conversación sin NINGÚN mensaje público (recién creada) queda fuera del bucket', async () => {
    const { conversationRepo, uc } = buildRepos();

    await conversationRepo.upsertByChatwootId({ chatwootConversationId: 1 });

    const withoutFilter = await uc.execute({});
    expect(withoutFilter.total).toBe(1); // la conversación existe (control no-vacío)

    const result = await uc.execute({ unattended: true });
    expect(result.total).toBe(0); // pero sin mensajes públicos no está "sin atender"
  });

  it('combinable con assigneeId (Mías + Sin atender) — AND, misma semántica que el listado', async () => {
    const { conversationRepo, messageRepo, uc } = buildRepos();

    const mine = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 1,
      lastMessageAt: '2026-07-15T10:00:00.000Z',
    });
    await conversationRepo.updateLocalFields(mine.id, { assigneeId: 'user-1' });
    await messageRepo.upsertByChatwootMessageId({
      conversationId: mine.id,
      chatwootMessageId: 100,
      direction: 'inbound',
      content: 'hola',
      chatwootCreatedAt: '2026-07-15T10:00:00.000Z',
    });

    const other = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 2,
      lastMessageAt: '2026-07-15T11:00:00.000Z',
    });
    await messageRepo.upsertByChatwootMessageId({
      conversationId: other.id,
      chatwootMessageId: 200,
      direction: 'inbound',
      content: 'buenas',
      chatwootCreatedAt: '2026-07-15T11:00:00.000Z',
    });

    const result = await uc.execute({ unattended: true, assigneeId: 'user-1' });

    expect(result.data.map((d) => d.id)).toEqual([mine.id]);
    expect(result.total).toBe(1);
  });

  it('unattended:true GANA sobre status (precedencia documentada en el port) — {unattended, status:resolved} devuelve el bucket Sin atender', async () => {
    const { conversationRepo, messageRepo, uc } = buildRepos();

    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 1,
      lastMessageAt: '2026-07-15T10:00:00.000Z',
    });
    await messageRepo.upsertByChatwootMessageId({
      conversationId: conv.id,
      chatwootMessageId: 100,
      direction: 'inbound',
      content: 'hola',
      chatwootCreatedAt: '2026-07-15T10:00:00.000Z',
    });

    const result = await uc.execute({ unattended: true, status: 'resolved' });

    expect(result.data.map((d) => d.id)).toEqual([conv.id]);
    expect(result.total).toBe(1);
  });
});
