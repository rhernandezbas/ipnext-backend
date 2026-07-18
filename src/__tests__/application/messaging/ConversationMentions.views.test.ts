/**
 * note-mentions (Ola 6b) — vista "Menciones" y su contador. Reusa `buildConversationWhere` /
 * `applyFilters` (una sola fuente de verdad): `?view=mentioned` = `list({ mentionedUserId })`,
 * y `counts.mentioned` = `count({ mentionedUserId })`. El filtro es INDEPENDIENTE del status
 * (una conversación resuelta con una mención NO leída SIGUE en la vista, igual que Chatwoot).
 * El count y el listado comparten el mismo filtro → el badge nunca diverge del listado.
 */
import { ListConversations } from '@application/use-cases/messaging/ListConversations';
import { GetInboxViewCounts } from '@application/use-cases/messaging/GetInboxViewCounts';
import { MarkConversationMentionsRead } from '@application/use-cases/messaging/MarkConversationMentionsRead';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryConversationMentionRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationMentionRepository';

/**
 * Dataset:
 * - A (open):     user-1 mencionado, NO leído   → mentioned(user-1)
 * - B (open):     user-1 mencionado, YA leído    → NO mentioned (readAt seteado)
 * - C (resolved): user-1 mencionado, NO leído   → mentioned(user-1) aunque resuelta
 * - D (open):     user-2 mencionado, NO leído   → mentioned(user-2), NO user-1
 * - E (open):     sin menciones                  → nunca en la vista
 */
async function seedDataset() {
  const conversationRepo = new InMemoryConversationRepository();
  const mentionRepo = new InMemoryConversationMentionRepository();
  conversationRepo.linkMentions(mentionRepo);

  const a = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 1, lastMessageAt: '2026-07-15T10:00:00.000Z' });
  await mentionRepo.record({ conversationId: a.id, messageId: 'a1', mentionedUserId: 'user-1', mentionedByUserId: 'user-9' });

  const b = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 2, lastMessageAt: '2026-07-15T11:00:00.000Z' });
  await mentionRepo.record({ conversationId: b.id, messageId: 'b1', mentionedUserId: 'user-1', mentionedByUserId: 'user-9' });
  await mentionRepo.markReadForUser(b.id, 'user-1', '2026-07-15T11:30:00.000Z'); // ya leída

  const c = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 3, status: 'resolved', lastMessageAt: '2026-07-15T09:00:00.000Z' });
  await mentionRepo.record({ conversationId: c.id, messageId: 'c1', mentionedUserId: 'user-1', mentionedByUserId: 'user-9' });

  const d = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 4, lastMessageAt: '2026-07-15T12:00:00.000Z' });
  await mentionRepo.record({ conversationId: d.id, messageId: 'd1', mentionedUserId: 'user-2', mentionedByUserId: 'user-9' });

  await conversationRepo.upsertByChatwootId({ chatwootConversationId: 5 }); // E — sin menciones

  return { conversationRepo, mentionRepo, ids: { a: a.id, b: b.id, c: c.id, d: d.id } };
}

describe('vista Menciones — listado (view=mentioned)', () => {
  it('lista SÓLO las conversaciones con una mención NO leída del user actual (incluye resueltas)', async () => {
    const { conversationRepo, ids } = await seedDataset();
    const uc = new ListConversations(conversationRepo);

    const result = await uc.execute({ mentionedUserId: 'user-1' });

    // A (open) + C (resolved), NO B (leída), NO D (otro user), NO E (sin menciones).
    expect(result.total).toBe(2);
    expect(result.data.map((c) => c.id).sort()).toEqual([ids.a, ids.c].sort());
  });

  it('el filtro depende del user: user-2 sólo ve la suya (D)', async () => {
    const { conversationRepo, ids } = await seedDataset();
    const uc = new ListConversations(conversationRepo);

    const result = await uc.execute({ mentionedUserId: 'user-2' });

    expect(result.total).toBe(1);
    expect(result.data[0]!.id).toBe(ids.d);
  });

  it('marcar leída saca la conversación de la vista', async () => {
    const { conversationRepo, mentionRepo, ids } = await seedDataset();
    const list = new ListConversations(conversationRepo);
    const markRead = new MarkConversationMentionsRead(conversationRepo, mentionRepo);

    await markRead.execute(ids.a, 'user-1');

    const after = await list.execute({ mentionedUserId: 'user-1' });
    // A salió; queda sólo C.
    expect(after.data.map((c) => c.id)).toEqual([ids.c]);
  });
});

describe('vista Menciones — contador (counts.mentioned)', () => {
  it('counts.mentioned cuenta las conversaciones con mención NO leída del user autenticado', async () => {
    const { conversationRepo } = await seedDataset();
    const uc = new GetInboxViewCounts(conversationRepo);

    const counts = await uc.execute('user-1');

    expect(counts.mentioned).toBe(2); // A + C
  });

  it('COHERENCIA: counts.mentioned === ListConversations.total para el MISMO user (badge = listado)', async () => {
    const { conversationRepo } = await seedDataset();
    const counts = await new GetInboxViewCounts(conversationRepo).execute('user-1');
    const list = await new ListConversations(conversationRepo).execute({ mentionedUserId: 'user-1' });

    expect(counts.mentioned).toBe(list.total);
  });

  it('userId vacío → mentioned=0 (guard: jamás degenerar en "todas")', async () => {
    const { conversationRepo } = await seedDataset();
    const counts = await new GetInboxViewCounts(conversationRepo).execute('');

    expect(counts.mentioned).toBe(0);
  });

  it('sin repo de menciones linkeado → mentioned degrada a 0 (nunca muestra de más)', async () => {
    // conversationRepo SIN linkMentions: el filtro mentionedUserId no encuentra menciones.
    const conversationRepo = new InMemoryConversationRepository();
    await conversationRepo.upsertByChatwootId({ chatwootConversationId: 1 });
    const counts = await new GetInboxViewCounts(conversationRepo).execute('user-1');

    expect(counts.mentioned).toBe(0);
  });
});
