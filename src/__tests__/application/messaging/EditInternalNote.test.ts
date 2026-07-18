/**
 * messaging-inbox-notes (edit/delete) — EditInternalNote. Autorización: el AUTOR
 * (authorId === actor.userId) O un SUPERVISOR (actor.hasManage). Guards tipados en el
 * orden del spec: existe (404) → es nota interna (422) → NO borrada (409) → autorizado
 * (403). Editar NO cambia el contador. In-memory (jamás mockear Prisma).
 */
import { EditInternalNote } from '@application/use-cases/messaging/EditInternalNote';
import {
  InternalNoteNotFoundError,
  NotAnInternalNoteError,
  InternalNoteForbiddenError,
  InternalNoteAlreadyDeletedError,
} from '@domain/errors/messaging';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';

const AT = '2026-07-20T00:00:00.000Z';

async function harness() {
  const conversationRepo = new InMemoryConversationRepository();
  const messageRepo = new InMemoryChatMessageRepository();
  messageRepo.linkConversationRepo(conversationRepo);
  const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 1 });
  const uc = new EditInternalNote(messageRepo, () => new Date(AT));

  /** Crea una nota interna atribuida a `authorId` (o pública/sin autor). */
  async function seedNote(opts: { chatwootMessageId: number; isPrivate?: boolean; authorId?: string | null }) {
    return messageRepo.upsertByChatwootMessageId({
      conversationId: conv.id,
      chatwootMessageId: opts.chatwootMessageId,
      direction: 'outbound',
      content: 'nota original',
      senderName: 'Agente',
      chatwootCreatedAt: '2026-07-19T00:00:00.000Z',
      isPrivate: opts.isPrivate ?? true,
      authorId: opts.authorId === undefined ? 'author-1' : opts.authorId,
    });
  }

  return { conversationRepo, messageRepo, conv, uc, seedNote };
}

describe('EditInternalNote', () => {
  it('el AUTOR edita → OK, content actualizado + editedAt seteado + DTO edited/canEdit', async () => {
    const { messageRepo, uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });

    const dto = await uc.execute(note.id, 'nota editada', { userId: 'author-1', hasManage: false });

    expect(dto.content).toBe('nota editada');
    expect(dto.edited).toBe(true);
    expect(dto.canEdit).toBe(true);
    const stored = await messageRepo.findById(note.id);
    expect(stored!.content).toBe('nota editada');
    expect(stored!.editedAt).toBe(AT);
  });

  it('OTRO usuario sin manage → Forbidden (no toca la nota)', async () => {
    const { messageRepo, uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });

    await expect(uc.execute(note.id, 'hack', { userId: 'intruso', hasManage: false })).rejects.toBeInstanceOf(
      InternalNoteForbiddenError,
    );
    const stored = await messageRepo.findById(note.id);
    expect(stored!.content).toBe('nota original');
    expect(stored!.editedAt).toBeNull();
  });

  it('SUPERVISOR (hasManage) que no es el autor → OK', async () => {
    const { uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });

    const dto = await uc.execute(note.id, 'moderada por supervisor', { userId: 'supervisor', hasManage: true });
    expect(dto.content).toBe('moderada por supervisor');
  });

  it('nota con authorId NULL → sólo el supervisor puede (autor desconocido)', async () => {
    const { uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: null });

    await expect(uc.execute(note.id, 'x', { userId: 'cualquiera', hasManage: false })).rejects.toBeInstanceOf(
      InternalNoteForbiddenError,
    );
    const dto = await uc.execute(note.id, 'editada por super', { userId: 'super', hasManage: true });
    expect(dto.content).toBe('editada por super');
  });

  it('editar un mensaje PÚBLICO (isPrivate:false) → NotAnInternalNote', async () => {
    const { uc, seedNote } = await harness();
    const pub = await seedNote({ chatwootMessageId: 1, isPrivate: false, authorId: null });

    await expect(uc.execute(pub.id, 'x', { userId: 'super', hasManage: true })).rejects.toBeInstanceOf(
      NotAnInternalNoteError,
    );
  });

  it('editar una nota YA borrada → AlreadyDeleted', async () => {
    const { messageRepo, uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });
    await messageRepo.softDelete(note.id, AT);

    await expect(uc.execute(note.id, 'x', { userId: 'author-1', hasManage: false })).rejects.toBeInstanceOf(
      InternalNoteAlreadyDeletedError,
    );
  });

  it('messageId inexistente → NotFound', async () => {
    const { uc } = await harness();
    await expect(uc.execute('ghost', 'x', { userId: 'author-1', hasManage: false })).rejects.toBeInstanceOf(
      InternalNoteNotFoundError,
    );
  });

  it('editar NO cambia internalNoteCount (no crea ni borra notas)', async () => {
    const { conversationRepo, conv, uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });
    expect((await conversationRepo.findById(conv.id))!.internalNoteCount).toBe(1);

    await uc.execute(note.id, 'editada', { userId: 'author-1', hasManage: false });
    expect((await conversationRepo.findById(conv.id))!.internalNoteCount).toBe(1);
  });
});
