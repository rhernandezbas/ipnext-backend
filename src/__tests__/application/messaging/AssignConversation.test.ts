/**
 * F1.5-C2 (asignación) — AssignConversation: asigna/desasigna un agente
 * (RbacUser) a una conversación del inbox. LOCAL-only: NUNCA llama al gateway
 * de Chatwoot (a diferencia de SetConversationStatus). Clon del patrón
 * Ticket.assigneeId.
 *
 * Uses `EntityLookup` (mismo minimal port que CreateTask/AssignRecaptureLeadsBulk)
 * para validar existencia del assignee, sin arrastrar el RbacUserRepository
 * completo a la capa de aplicación (DIP estricto).
 */
import { AssignConversation } from '@application/use-cases/messaging/AssignConversation';
import { ConversationNotFoundError } from '@domain/errors/messaging';
import { UserNotFoundError } from '@domain/errors/rbacUser.errors';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import type { EntityLookup } from '@domain/ports/EntityLookup';

function makeUserLookup(knownIds: string[]): EntityLookup {
  return {
    findById: async (id: string) =>
      knownIds.includes(id) ? { id, name: `User ${id}` } : null,
  };
}

function makeHarness(knownUserIds: string[] = ['user-1']) {
  const conversationRepo = new InMemoryConversationRepository();
  conversationRepo.seedUsers(knownUserIds.map((id) => ({ id, name: `User ${id}` })));
  const userLookup = makeUserLookup(knownUserIds);
  const uc = new AssignConversation(conversationRepo, userLookup);
  return { conversationRepo, uc };
}

describe('AssignConversation', () => {
  it('asigna un agente válido: actualiza SOLO assigneeId y devuelve el DTO con assignee poblado', async () => {
    const { conversationRepo, uc } = makeHarness(['user-1']);
    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 200,
      status: 'open',
      lastMessagePreview: 'hola',
      lastMessageAt: '2026-07-01T00:00:00.000Z',
    });

    const result = await uc.execute(conv.id, 'user-1');

    expect(result.assignee).toEqual({ id: 'user-1', name: 'User user-1' });
    expect(result.status).toBe('open'); // no tocado
    expect(result.preview).toBe('hola'); // no tocado

    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.assigneeId).toBe('user-1');
  });

  it('desasigna (assigneeId null): NO valida existencia (skip lookup) y limpia el assignee', async () => {
    const { conversationRepo, uc } = makeHarness(['user-1']);
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 201 });
    await conversationRepo.updateLocalFields(conv.id, { assigneeId: 'user-1' });

    const result = await uc.execute(conv.id, null);

    expect(result.assignee).toBeNull();
    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.assigneeId).toBeNull();
  });

  it('conversación inexistente → ConversationNotFoundError, SIN llamar al lookup de usuario', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const lookup: EntityLookup = { findById: jest.fn().mockRejectedValue(new Error('no debería llamarse')) };
    const uc = new AssignConversation(conversationRepo, lookup);

    await expect(uc.execute('ghost-conv', 'user-1')).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(lookup.findById).not.toHaveBeenCalled();
  });

  it('assigneeId no existe → UserNotFoundError, mirror SIN tocar', async () => {
    const { conversationRepo, uc } = makeHarness([]); // ningún usuario conocido
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 202 });

    await expect(uc.execute(conv.id, 'ghost-user')).rejects.toBeInstanceOf(UserNotFoundError);

    const stillUnassigned = await conversationRepo.findById(conv.id);
    expect(stillUnassigned!.assigneeId).toBeNull();
  });

  it('NUNCA toca status/canReply/lastMessagePreview/lastMessageAt/areaId (solo assigneeId)', async () => {
    const { conversationRepo, uc } = makeHarness(['user-1']);
    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 203,
      status: 'resolved',
      canReply: true,
      lastMessagePreview: 'preview original',
      lastMessageAt: '2026-07-05T00:00:00.000Z',
    });
    await conversationRepo.updateLocalFields(conv.id, { areaId: null });

    await uc.execute(conv.id, 'user-1');

    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.status).toBe('resolved');
    expect(updated!.canReply).toBe(true);
    expect(updated!.lastMessagePreview).toBe('preview original');
    expect(updated!.lastMessageAt).toBe('2026-07-05T00:00:00.000Z');
    expect(updated!.areaId).toBeNull();
  });
});
