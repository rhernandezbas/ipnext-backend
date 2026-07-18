/**
 * previous-conversations (Ola 6a) — `ListPreviousConversations` lista las OTRAS
 * conversaciones del MISMO contacto (mismo `contactPhoneE164` canónico que usa el
 * contador `convo-count`) para el panel de contexto del inbox, EXCLUYENDO la
 * conversación actual, ordenadas por `lastMessageAt` DESC, mapeadas a un DTO
 * liviano. Strict TDD, in-memory port (jamás Prisma).
 */
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryConversationLabelRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationLabelRepository';
import { ListPreviousConversations } from '@application/use-cases/messaging/ListPreviousConversations';
import { ConversationNotFoundError } from '@domain/errors/messaging';

describe('ListPreviousConversations (previous-conversations Ola 6a)', () => {
  let repo: InMemoryConversationRepository;
  let uc: ListPreviousConversations;

  beforeEach(() => {
    repo = new InMemoryConversationRepository();
    uc = new ListPreviousConversations(repo);
  });

  it(':id inexistente en el mirror → ConversationNotFoundError', async () => {
    await expect(uc.execute('ghost')).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it('contacto sin otras conversaciones → []', async () => {
    const conv = await repo.upsertByChatwootId({ chatwootConversationId: 1, contactPhone: '+5492324421234' });

    await expect(uc.execute(conv.id)).resolves.toEqual([]);
  });

  it('lista las OTRAS conversaciones del mismo contacto (excluye la actual), ordenadas por lastMessageAt DESC, mapeadas al DTO liviano', async () => {
    const current = await repo.upsertByChatwootId({
      chatwootConversationId: 1,
      contactPhone: '+5492324421234',
      lastMessageAt: '2026-07-16T10:00:00.000Z',
    });
    const older = await repo.upsertByChatwootId({
      chatwootConversationId: 2,
      contactPhone: '02324421234', // cross-format, mismo E164 canónico
      status: 'resolved',
      lastMessagePreview: 'gracias!',
      lastMessageAt: '2026-07-10T10:00:00.000Z',
    });
    const newer = await repo.upsertByChatwootId({
      chatwootConversationId: 3,
      contactPhone: '+5492324421234',
      lastMessageAt: '2026-07-14T10:00:00.000Z',
    });

    const result = await uc.execute(current.id);

    expect(result.map((r) => r.id)).toEqual([newer.id, older.id]);
    // DTO liviano — jamás el record crudo del mirror
    expect(result[0]).not.toHaveProperty('chatwootConversationId');
    expect(result[0]).not.toHaveProperty('contactPhoneE164');
    // usa `lastMessagePreview` (no el rename `preview` del item pesado)
    expect(result[1]).toMatchObject({ id: older.id, status: 'resolved', lastMessagePreview: 'gracias!' });
  });

  it('respeta un limit configurable (las N más recientes)', async () => {
    const ucLimit1 = new ListPreviousConversations(repo, { limit: 1 });
    const current = await repo.upsertByChatwootId({
      chatwootConversationId: 1,
      contactPhone: '+5492324421234',
      lastMessageAt: '2026-07-16T10:00:00.000Z',
    });
    await repo.upsertByChatwootId({
      chatwootConversationId: 2,
      contactPhone: '+5492324421234',
      lastMessageAt: '2026-07-10T10:00:00.000Z',
    });
    const newer = await repo.upsertByChatwootId({
      chatwootConversationId: 3,
      contactPhone: '+5492324421234',
      lastMessageAt: '2026-07-14T10:00:00.000Z',
    });

    const result = await ucLimit1.execute(current.id);

    expect(result.map((r) => r.id)).toEqual([newer.id]);
  });

  it('teléfono NO reconstruible a E164 (clave canónica null) → [] (no agrupa strings crudos heterogéneos)', async () => {
    const current = await repo.upsertByChatwootId({ chatwootConversationId: 1, contactPhone: '12345' });
    await repo.upsertByChatwootId({ chatwootConversationId: 2, contactPhone: '12345' });

    await expect(uc.execute(current.id)).resolves.toEqual([]);
  });

  it('el DTO liviano incluye labels y assigneeName de cada previa', async () => {
    const labelRepo = new InMemoryConversationLabelRepository();
    const urgente = await labelRepo.create({ name: 'Urgente', color: '#ef4444' });
    repo.seedLabels(labelRepo);
    repo.seedUsers([{ id: 'user-1', name: 'Agente Uno' }]);

    const current = await repo.upsertByChatwootId({
      chatwootConversationId: 1,
      contactPhone: '+5492324421234',
      lastMessageAt: '2026-07-16T10:00:00.000Z',
    });
    const prev = await repo.upsertByChatwootId({
      chatwootConversationId: 2,
      contactPhone: '+5492324421234',
      lastMessageAt: '2026-07-10T10:00:00.000Z',
    });
    await repo.updateLocalFields(prev.id, { assigneeId: 'user-1' });
    await repo.setLabels(prev.id, [urgente.id]);

    const result = await uc.execute(current.id);

    expect(result).toHaveLength(1);
    expect(result[0].assigneeName).toBe('Agente Uno');
    expect(result[0].labels).toEqual([{ id: urgente.id, name: 'Urgente', color: '#ef4444' }]);
  });
});
