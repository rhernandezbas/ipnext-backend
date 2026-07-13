/**
 * F1.5-C2 (asignación) — SetConversationArea: setea/limpia el área (TicketAreaCatalog)
 * de una conversación del inbox. LOCAL-only, sin llamada a Chatwoot. Reusa
 * `TicketAreaCatalogRepository` (mismo puerto que ListTicketAreas/CreateTicketArea)
 * en vez de introducir un lookup nuevo — el catálogo de áreas ya es un puerto
 * de dominio legítimo para cualquier use case que lo necesite.
 */
import { SetConversationArea } from '@application/use-cases/messaging/SetConversationArea';
import { ConversationNotFoundError } from '@domain/errors/messaging';
import { TicketAreaNotFoundError } from '@domain/errors/tickets';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';

function makeHarness() {
  const conversationRepo = new InMemoryConversationRepository();
  const areaRepo = new InMemoryTicketAreaCatalogRepository();
  conversationRepo.seedAreas(areaRepo);
  const uc = new SetConversationArea(conversationRepo, areaRepo);
  return { conversationRepo, areaRepo, uc };
}

describe('SetConversationArea', () => {
  it('setea un área válida: actualiza SOLO areaId y devuelve el DTO con area poblada', async () => {
    const { conversationRepo, areaRepo, uc } = makeHarness();
    const area = await areaRepo.create({ name: 'Soporte', color: '#ff0000' });
    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 300,
      status: 'open',
      lastMessagePreview: 'hola',
    });

    const result = await uc.execute(conv.id, area.id);

    expect(result.area).toEqual({ id: area.id, name: 'Soporte', color: '#ff0000' });
    expect(result.status).toBe('open'); // no tocado
    expect(result.preview).toBe('hola'); // no tocado

    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.areaId).toBe(area.id);
  });

  it('limpia el área (areaId null): NO valida existencia y limpia area', async () => {
    const { conversationRepo, areaRepo, uc } = makeHarness();
    const area = await areaRepo.create({ name: 'Facturación', color: '#00ff00' });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 301 });
    await conversationRepo.updateLocalFields(conv.id, { areaId: area.id });

    const result = await uc.execute(conv.id, null);

    expect(result.area).toBeNull();
    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.areaId).toBeNull();
  });

  it('conversación inexistente → ConversationNotFoundError, SIN tocar el repo de áreas', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const areaRepo = new InMemoryTicketAreaCatalogRepository();
    const getByIdSpy = jest.spyOn(areaRepo, 'getById');
    const uc = new SetConversationArea(conversationRepo, areaRepo);

    await expect(uc.execute('ghost-conv', 'area-1')).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(getByIdSpy).not.toHaveBeenCalled();
  });

  it('areaId no existe → TicketAreaNotFoundError, mirror SIN tocar', async () => {
    const { conversationRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 302 });

    await expect(uc.execute(conv.id, 'ghost-area')).rejects.toBeInstanceOf(TicketAreaNotFoundError);

    const stillNoArea = await conversationRepo.findById(conv.id);
    expect(stillNoArea!.areaId).toBeNull();
  });

  it('NUNCA toca status/canReply/lastMessagePreview/lastMessageAt/assigneeId (solo areaId)', async () => {
    const { conversationRepo, areaRepo, uc } = makeHarness();
    const area = await areaRepo.create({ name: 'Administración', color: '#0000ff' });
    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 303,
      status: 'resolved',
      canReply: true,
      lastMessagePreview: 'preview original',
      lastMessageAt: '2026-07-05T00:00:00.000Z',
    });
    conversationRepo.seedUsers([{ id: 'user-1', name: 'Agente Uno' }]);
    await conversationRepo.updateLocalFields(conv.id, { assigneeId: 'user-1' });

    await uc.execute(conv.id, area.id);

    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.status).toBe('resolved');
    expect(updated!.canReply).toBe(true);
    expect(updated!.lastMessagePreview).toBe('preview original');
    expect(updated!.lastMessageAt).toBe('2026-07-05T00:00:00.000Z');
    expect(updated!.assigneeId).toBe('user-1');
  });
});
