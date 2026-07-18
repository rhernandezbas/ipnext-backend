/**
 * messaging-inbox-notes (edit/delete) — DeleteInternalNote. SOFT-delete (deletedAt,
 * NUNCA borra la fila) + recompute de internalNoteCount + MISMA autorización/orden de
 * guards que EditInternalNote. In-memory (jamás mockear Prisma).
 */
import { DeleteInternalNote } from '@application/use-cases/messaging/DeleteInternalNote';
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
  const uc = new DeleteInternalNote(messageRepo, () => new Date(AT));

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

describe('DeleteInternalNote', () => {
  it('soft-delete: marca deletedAt SIN borrar la fila; el hilo la sigue devolviendo con deleted=true y content vacío', async () => {
    const { messageRepo, conv, uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });

    const dto = await uc.execute(note.id, { userId: 'author-1', hasManage: false });

    expect(dto.deleted).toBe(true);
    expect(dto.content).toBe('');
    // la fila NO se borra
    const rows = await messageRepo.listByConversation(conv.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deletedAt).toBe(AT);
  });

  it('baja el internalNoteCount (la nota borrada deja de contar)', async () => {
    const { conversationRepo, conv, uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });
    expect((await conversationRepo.findById(conv.id))!.internalNoteCount).toBe(1);

    await uc.execute(note.id, { userId: 'author-1', hasManage: false });
    expect((await conversationRepo.findById(conv.id))!.internalNoteCount).toBe(0);
  });

  it('OTRO usuario sin manage → Forbidden (no borra)', async () => {
    const { messageRepo, uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });

    await expect(uc.execute(note.id, { userId: 'intruso', hasManage: false })).rejects.toBeInstanceOf(
      InternalNoteForbiddenError,
    );
    expect((await messageRepo.findById(note.id))!.deletedAt).toBeNull();
  });

  it('SUPERVISOR (hasManage) → OK aunque no sea el autor', async () => {
    const { messageRepo, uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });

    const dto = await uc.execute(note.id, { userId: 'supervisor', hasManage: true });
    expect(dto.deleted).toBe(true);
    expect((await messageRepo.findById(note.id))!.deletedAt).toBe(AT);
  });

  it('nota authorId NULL → sólo el supervisor puede', async () => {
    const { uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: null });

    await expect(uc.execute(note.id, { userId: 'x', hasManage: false })).rejects.toBeInstanceOf(
      InternalNoteForbiddenError,
    );
    const dto = await uc.execute(note.id, { userId: 'x', hasManage: true });
    expect(dto.deleted).toBe(true);
  });

  it('borrar un mensaje PÚBLICO → NotAnInternalNote', async () => {
    const { uc, seedNote } = await harness();
    const pub = await seedNote({ chatwootMessageId: 1, isPrivate: false, authorId: null });
    await expect(uc.execute(pub.id, { userId: 'super', hasManage: true })).rejects.toBeInstanceOf(NotAnInternalNoteError);
  });

  it('borrar una nota YA borrada → AlreadyDeleted', async () => {
    const { uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });
    await uc.execute(note.id, { userId: 'author-1', hasManage: false });
    await expect(uc.execute(note.id, { userId: 'author-1', hasManage: false })).rejects.toBeInstanceOf(
      InternalNoteAlreadyDeletedError,
    );
  });

  it('messageId inexistente → NotFound', async () => {
    const { uc } = await harness();
    await expect(uc.execute('ghost', { userId: 'author-1', hasManage: false })).rejects.toBeInstanceOf(
      InternalNoteNotFoundError,
    );
  });
});
