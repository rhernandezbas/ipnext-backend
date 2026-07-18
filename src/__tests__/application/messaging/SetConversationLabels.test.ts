/**
 * conversation-labels (Ola 5) — SetConversationLabels: reemplaza el set de labels
 * de una conversación (LOCAL-only, sin Chatwoot). Molde de SetConversationArea:
 * valida conversación (404), valida que TODAS las labels existan (404 atómico),
 * reemplaza (no acumula), no toca ningún otro campo.
 */
import { SetConversationLabels } from '@application/use-cases/messaging/SetConversationLabels';
import { ConversationNotFoundError, ConversationLabelNotFoundError } from '@domain/errors/messaging';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryConversationLabelRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationLabelRepository';

function makeHarness() {
  const conversationRepo = new InMemoryConversationRepository();
  const labelRepo = new InMemoryConversationLabelRepository();
  conversationRepo.seedLabels(labelRepo);
  const uc = new SetConversationLabels(conversationRepo, labelRepo);
  return { conversationRepo, labelRepo, uc };
}

describe('SetConversationLabels', () => {
  it('setea labels válidas: devuelve el DTO con labels pobladas (id/name/color)', async () => {
    const { conversationRepo, labelRepo, uc } = makeHarness();
    const urgente = await labelRepo.create({ name: 'Urgente', color: '#ef4444' });
    const ventas = await labelRepo.create({ name: 'Ventas', color: '#22c55e' });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 700, status: 'open', lastMessagePreview: 'hola' });

    const result = await uc.execute(conv.id, [urgente.id, ventas.id]);

    expect(result.labels).toEqual([
      { id: urgente.id, name: 'Urgente', color: '#ef4444' },
      { id: ventas.id, name: 'Ventas', color: '#22c55e' },
    ]);
    expect(result.status).toBe('open'); // no tocado
    expect(result.preview).toBe('hola'); // no tocado
  });

  it('REEMPLAZA (no acumula): un segundo set pisa el anterior', async () => {
    const { conversationRepo, labelRepo, uc } = makeHarness();
    const a = await labelRepo.create({ name: 'A', color: '#111111' });
    const b = await labelRepo.create({ name: 'B', color: '#222222' });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 701 });

    await uc.execute(conv.id, [a.id]);
    const result = await uc.execute(conv.id, [b.id]);

    expect(result.labels).toEqual([{ id: b.id, name: 'B', color: '#222222' }]);
  });

  it('set vacío limpia todas las labels', async () => {
    const { conversationRepo, labelRepo, uc } = makeHarness();
    const a = await labelRepo.create({ name: 'A', color: '#111111' });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 702 });
    await uc.execute(conv.id, [a.id]);

    const result = await uc.execute(conv.id, []);

    expect(result.labels).toEqual([]);
  });

  it('deduplica ids repetidos', async () => {
    const { conversationRepo, labelRepo, uc } = makeHarness();
    const a = await labelRepo.create({ name: 'A', color: '#111111' });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 703 });

    const result = await uc.execute(conv.id, [a.id, a.id, a.id]);

    expect(result.labels).toEqual([{ id: a.id, name: 'A', color: '#111111' }]);
  });

  it('conversación inexistente → ConversationNotFoundError, SIN tocar el repo de labels', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const labelRepo = new InMemoryConversationLabelRepository();
    conversationRepo.seedLabels(labelRepo);
    const findByIdsSpy = jest.spyOn(labelRepo, 'findByIds');
    const uc = new SetConversationLabels(conversationRepo, labelRepo);

    await expect(uc.execute('ghost-conv', ['label-1'])).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(findByIdsSpy).not.toHaveBeenCalled();
  });

  it('CUALQUIER labelId inexistente → ConversationLabelNotFoundError, mirror SIN tocar (atómico)', async () => {
    const { conversationRepo, labelRepo, uc } = makeHarness();
    const ok = await labelRepo.create({ name: 'OK', color: '#333333' });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 704 });

    await expect(uc.execute(conv.id, [ok.id, 'ghost-label'])).rejects.toBeInstanceOf(
      ConversationLabelNotFoundError,
    );

    const still = await conversationRepo.findById(conv.id);
    expect(still!.labels).toEqual([]); // no aplicó parcialmente
  });

  it('NUNCA toca status/canReply/preview/assigneeId/areaId (solo labels)', async () => {
    const { conversationRepo, labelRepo, uc } = makeHarness();
    const a = await labelRepo.create({ name: 'A', color: '#111111' });
    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 705,
      status: 'resolved',
      canReply: true,
      lastMessagePreview: 'preview original',
    });
    conversationRepo.seedUsers([{ id: 'user-1', name: 'Agente Uno' }]);
    await conversationRepo.updateLocalFields(conv.id, { assigneeId: 'user-1' });

    await uc.execute(conv.id, [a.id]);

    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.status).toBe('resolved');
    expect(updated!.canReply).toBe(true);
    expect(updated!.lastMessagePreview).toBe('preview original');
    expect(updated!.assigneeId).toBe('user-1');
  });
});
