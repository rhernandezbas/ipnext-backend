/**
 * inbox-views (Ola 1, COUNT-1/2) — `GetInboxViewCounts`: los 5 buckets del inbox
 * en un solo roundtrip lógico (counts en PARALELO vía `ConversationRepository.count`,
 * jamás trae filas). Los buckets usan EXACTAMENTE la misma semántica de filtros que
 * el listado (misma fuente de verdad: `applyFilters`/`buildConversationWhere` en los
 * adapters) — el test de coherencia de abajo lo pinea contra `ListConversations`
 * sobre el MISMO dataset.
 *
 * Buckets: mine/unattended/all/unassigned sobre NO-resueltas; resolved aparte.
 */
import { GetInboxViewCounts } from '@application/use-cases/messaging/GetInboxViewCounts';
import { ListConversations } from '@application/use-cases/messaging/ListConversations';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';

/**
 * Dataset compartido:
 * - A: open, sin asignar, último público INBOUND      → all, unassigned, unattended
 * - B: open, asignada user-1, último público OUTBOUND → all, mine(user-1)
 * - C: open, asignada user-2, último público INBOUND  → all, unattended, mine(user-2)
 * - D: resolved, último público INBOUND               → resolved (fuera de TODO lo demás)
 * - E: open, sin asignar, SIN mensajes                → all, unassigned (NO unattended)
 */
async function seedDataset() {
  const conversationRepo = new InMemoryConversationRepository();
  const messageRepo = new InMemoryChatMessageRepository();
  messageRepo.linkConversationRepo(conversationRepo);

  const a = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 1, lastMessageAt: '2026-07-15T10:00:00.000Z' });
  await messageRepo.upsertByChatwootMessageId({
    conversationId: a.id,
    chatwootMessageId: 100,
    direction: 'inbound',
    content: 'hola',
    chatwootCreatedAt: '2026-07-15T10:00:00.000Z',
  });

  const b = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 2, lastMessageAt: '2026-07-15T11:00:00.000Z' });
  await conversationRepo.updateLocalFields(b.id, { assigneeId: 'user-1' });
  await messageRepo.upsertByChatwootMessageId({
    conversationId: b.id,
    chatwootMessageId: 200,
    direction: 'inbound',
    content: 'buenas',
    chatwootCreatedAt: '2026-07-15T10:30:00.000Z',
  });
  await messageRepo.upsertByChatwootMessageId({
    conversationId: b.id,
    chatwootMessageId: 201,
    direction: 'outbound',
    content: 'ya te respondo',
    chatwootCreatedAt: '2026-07-15T11:00:00.000Z',
  });

  const c = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 3, lastMessageAt: '2026-07-15T12:00:00.000Z' });
  await conversationRepo.updateLocalFields(c.id, { assigneeId: 'user-2' });
  await messageRepo.upsertByChatwootMessageId({
    conversationId: c.id,
    chatwootMessageId: 300,
    direction: 'inbound',
    content: 'sigo esperando',
    chatwootCreatedAt: '2026-07-15T12:00:00.000Z',
  });

  const d = await conversationRepo.upsertByChatwootId({
    chatwootConversationId: 4,
    status: 'resolved',
    lastMessageAt: '2026-07-15T09:00:00.000Z',
  });
  await messageRepo.upsertByChatwootMessageId({
    conversationId: d.id,
    chatwootMessageId: 400,
    direction: 'inbound',
    content: 'gracias!',
    chatwootCreatedAt: '2026-07-15T09:00:00.000Z',
  });

  await conversationRepo.upsertByChatwootId({ chatwootConversationId: 5 }); // E — sin mensajes

  return { conversationRepo, messageRepo };
}

describe('GetInboxViewCounts — contadores por vista (inbox-views COUNT-1)', () => {
  it('devuelve los 5 buckets para el user autenticado (user-1)', async () => {
    const { conversationRepo } = await seedDataset();
    const uc = new GetInboxViewCounts(conversationRepo);

    const counts = await uc.execute('user-1');

    expect(counts).toEqual({ all: 4, mine: 1, unassigned: 2, unattended: 2, resolved: 1, mentioned: 0 });
  });

  it('mine depende del user — user-2 ve SU conversación asignada (triangulación)', async () => {
    const { conversationRepo } = await seedDataset();
    const uc = new GetInboxViewCounts(conversationRepo);

    const counts = await uc.execute('user-2');

    expect(counts).toEqual({ all: 4, mine: 1, unassigned: 2, unattended: 2, resolved: 1, mentioned: 0 });
    // El mine de user-2 es la conv C (inbound last) — distinta de la B de user-1;
    // lo distinguimos vía un user sin nada asignado:
    const nobody = await uc.execute('user-ghost');
    expect(nobody.mine).toBe(0);
    expect(nobody.all).toBe(4);
  });

  it('userId vacío → mine=0 (guard: jamás degenerar en el bucket all)', async () => {
    const { conversationRepo } = await seedDataset();
    const uc = new GetInboxViewCounts(conversationRepo);

    const counts = await uc.execute('');

    expect(counts.mine).toBe(0);
    expect(counts.all).toBe(4);
  });

  it('COHERENCIA con el listado: mismo dataset → mismos números que ListConversations.total por bucket', async () => {
    const { conversationRepo } = await seedDataset();
    const countsUc = new GetInboxViewCounts(conversationRepo);
    const listUc = new ListConversations(conversationRepo);

    const counts = await countsUc.execute('user-1');

    const [all, mine, unassigned, unattended, resolved] = await Promise.all([
      listUc.execute({ status: 'open' }),
      listUc.execute({ status: 'open', assigneeId: 'user-1' }),
      listUc.execute({ status: 'open', unassigned: true }),
      listUc.execute({ unattended: true }),
      listUc.execute({ status: 'resolved' }),
    ]);

    expect(counts.all).toBe(all.total);
    expect(counts.mine).toBe(mine.total);
    expect(counts.unassigned).toBe(unassigned.total);
    expect(counts.unattended).toBe(unattended.total);
    expect(counts.resolved).toBe(resolved.total);
  });

  it('el agente responde → unattended baja, el resto de los buckets no se mueve', async () => {
    const { conversationRepo, messageRepo } = await seedDataset();
    const uc = new GetInboxViewCounts(conversationRepo);

    const before = await uc.execute('user-1');
    expect(before.unattended).toBe(2);

    // Responde la conv C (chatwootConversationId 3, asignada a user-2, inbound last)
    const c = await conversationRepo.findByChatwootId(3);
    await messageRepo.upsertByChatwootMessageId({
      conversationId: c!.id,
      chatwootMessageId: 301,
      direction: 'outbound',
      content: 'resuelto, avisanos',
      chatwootCreatedAt: '2026-07-15T13:00:00.000Z',
    });

    const after = await uc.execute('user-1');
    expect(after).toEqual({ all: 4, mine: 1, unassigned: 2, unattended: 1, resolved: 1, mentioned: 0 });
  });
});
