/**
 * messaging-bulk-inbox (F1, T4, etiqueta #1) — filtro ?campaignId + DTO.campaigns.
 * ListConversations REAL + InMemoryConversationRepository (SEAM). El lazo
 * CampaignRecipient(conversationId, campaignId) se modela con `linkCampaign` (el
 * fake del JOIN que el adapter Prisma resuelve por include).
 */
import { ListConversations } from '@application/use-cases/messaging/ListConversations';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';

async function seedConv(repo: InMemoryConversationRepository, chatwootId: number, name: string, at: string) {
  const conv = await repo.upsertByChatwootId({
    chatwootConversationId: chatwootId,
    contactName: name,
    lastMessageAt: at,
    lastMessagePreview: 'hola',
  });
  return conv;
}

describe('ListConversations — filtro por campaña (T4, etiqueta #1)', () => {
  it('?campaignId=X devuelve SOLO las conversaciones de esa campaña y el DTO trae `campaigns`', async () => {
    const repo = new InMemoryConversationRepository();
    const uc = new ListConversations(repo);

    const a = await seedConv(repo, 1, 'A', '2026-07-10T10:00:00.000Z');
    const b = await seedConv(repo, 2, 'B', '2026-07-11T10:00:00.000Z');
    await seedConv(repo, 3, 'C', '2026-07-12T10:00:00.000Z'); // sin campaña

    repo.linkCampaign(a.id, { id: 'camp-1', name: 'Recordatorio Julio' });
    repo.linkCampaign(b.id, { id: 'camp-1', name: 'Recordatorio Julio' });

    const result = await uc.execute({ campaignId: 'camp-1' });

    expect(result.data.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
    expect(result.total).toBe(2);
    expect(result.data.every((d) => d.campaigns.some((c) => c.id === 'camp-1' && c.name === 'Recordatorio Julio'))).toBe(true);
  });

  it('sin ?campaignId lista todas; una conversación no asociada expone campaigns: []', async () => {
    const repo = new InMemoryConversationRepository();
    const uc = new ListConversations(repo);

    const a = await seedConv(repo, 1, 'A', '2026-07-10T10:00:00.000Z');
    await seedConv(repo, 2, 'B', '2026-07-11T10:00:00.000Z');
    repo.linkCampaign(a.id, { id: 'camp-1', name: 'Recordatorio' });

    const result = await uc.execute({});

    expect(result.total).toBe(2);
    const dtoB = result.data.find((d) => d.contactName === 'B')!;
    expect(dtoB.campaigns).toEqual([]);
    const dtoA = result.data.find((d) => d.contactName === 'A')!;
    expect(dtoA.campaigns).toEqual([{ id: 'camp-1', name: 'Recordatorio' }]);
  });
});
