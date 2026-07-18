/**
 * conversation-labels (Ola 5) — filtro ?labelId + DTO.labels. ListConversations REAL
 * + InMemoryConversationRepository (SEAM). Las labels se resuelven al ESCRIBIR
 * (setLabels, simulando el JOIN que el adapter Prisma hace por include), así que el
 * listado NO dispara ningún lookup por fila (anti-N+1).
 */
import { ListConversations } from '@application/use-cases/messaging/ListConversations';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryConversationLabelRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationLabelRepository';

function makeHarness() {
  const repo = new InMemoryConversationRepository();
  const labelRepo = new InMemoryConversationLabelRepository();
  repo.seedLabels(labelRepo);
  const uc = new ListConversations(repo);
  return { repo, labelRepo, uc };
}

async function seedConv(repo: InMemoryConversationRepository, chatwootId: number, name: string, at: string) {
  return repo.upsertByChatwootId({
    chatwootConversationId: chatwootId,
    contactName: name,
    lastMessageAt: at,
    lastMessagePreview: 'hola',
  });
}

describe('ListConversations — filtro por label (Ola 5)', () => {
  it('?labelId=X devuelve SOLO las conversaciones con esa label y el DTO trae `labels`', async () => {
    const { repo, labelRepo, uc } = makeHarness();
    const urgente = await labelRepo.create({ name: 'Urgente', color: '#ef4444' });

    const a = await seedConv(repo, 1, 'A', '2026-07-10T10:00:00.000Z');
    const b = await seedConv(repo, 2, 'B', '2026-07-11T10:00:00.000Z');
    await seedConv(repo, 3, 'C', '2026-07-12T10:00:00.000Z'); // sin label

    await repo.setLabels(a.id, [urgente.id]);
    await repo.setLabels(b.id, [urgente.id]);

    const result = await uc.execute({ labelId: urgente.id });

    expect(result.data.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
    expect(result.total).toBe(2);
    expect(
      result.data.every((d) => d.labels.some((l) => l.id === urgente.id && l.name === 'Urgente' && l.color === '#ef4444')),
    ).toBe(true);
  });

  it('sin ?labelId lista todas; una conversación sin labels expone labels: []', async () => {
    const { repo, labelRepo, uc } = makeHarness();
    const urgente = await labelRepo.create({ name: 'Urgente', color: '#ef4444' });

    const a = await seedConv(repo, 1, 'A', '2026-07-10T10:00:00.000Z');
    await seedConv(repo, 2, 'B', '2026-07-11T10:00:00.000Z');
    await repo.setLabels(a.id, [urgente.id]);

    const result = await uc.execute({});

    expect(result.total).toBe(2);
    const dtoB = result.data.find((d) => d.contactName === 'B')!;
    expect(dtoB.labels).toEqual([]);
    const dtoA = result.data.find((d) => d.contactName === 'A')!;
    expect(dtoA.labels).toEqual([{ id: urgente.id, name: 'Urgente', color: '#ef4444' }]);
  });

  it('anti-N+1: listar NO consulta el catálogo de labels por fila (labels ya resueltas en el record)', async () => {
    const { repo, labelRepo, uc } = makeHarness();
    const urgente = await labelRepo.create({ name: 'Urgente', color: '#ef4444' });
    for (let i = 1; i <= 5; i++) {
      const c = await seedConv(repo, i, `C${i}`, `2026-07-1${i}T10:00:00.000Z`);
      await repo.setLabels(c.id, [urgente.id]);
    }

    const findByIdsSpy = jest.spyOn(labelRepo, 'findByIds');
    const getByIdSpy = jest.spyOn(labelRepo, 'getById');

    const result = await uc.execute({ labelId: urgente.id });

    expect(result.total).toBe(5);
    expect(result.data.every((d) => d.labels.length === 1)).toBe(true);
    // El listado NO toca el catálogo (ni por fila ni una vez): las labels están
    // desnormalizadas en el record (espejo del include de Prisma).
    expect(findByIdsSpy).not.toHaveBeenCalled();
    expect(getByIdSpy).not.toHaveBeenCalled();
  });

  it('combina en AND con ?campaignId (mismo builder de where)', async () => {
    const { repo, labelRepo, uc } = makeHarness();
    const urgente = await labelRepo.create({ name: 'Urgente', color: '#ef4444' });
    const a = await seedConv(repo, 1, 'A', '2026-07-10T10:00:00.000Z');
    const b = await seedConv(repo, 2, 'B', '2026-07-11T10:00:00.000Z');
    await repo.setLabels(a.id, [urgente.id]);
    await repo.setLabels(b.id, [urgente.id]);
    repo.linkCampaign(a.id, { id: 'camp-1', name: 'Julio' });

    const result = await uc.execute({ labelId: urgente.id, campaignId: 'camp-1' });

    expect(result.data.map((d) => d.id)).toEqual([a.id]);
    expect(result.total).toBe(1);
  });
});
