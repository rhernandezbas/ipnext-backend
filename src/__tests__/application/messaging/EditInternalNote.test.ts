/**
 * messaging-inbox-notes (edit/delete) — EditInternalNote. Autorización: el AUTOR
 * (authorId === actor.userId) O un SUPERVISOR (actor.hasManage). Guards tipados en el
 * orden del spec: existe + pertenece a la conversación (404) → es nota interna (422) →
 * NO borrada (409) → autorizado (403). Editar NO cambia el contador. In-memory (jamás
 * mockear Prisma).
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
  async function seedNote(opts: {
    chatwootMessageId: number;
    isPrivate?: boolean;
    authorId?: string | null;
    conversationId?: string;
  }) {
    return messageRepo.upsertByChatwootMessageId({
      conversationId: opts.conversationId ?? conv.id,
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
    const { messageRepo, conv, uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });

    const dto = await uc.execute(conv.id, note.id, 'nota editada', { userId: 'author-1', hasManage: false });

    expect(dto.content).toBe('nota editada');
    expect(dto.edited).toBe(true);
    expect(dto.canEdit).toBe(true);
    const stored = await messageRepo.findById(note.id);
    expect(stored!.content).toBe('nota editada');
    expect(stored!.editedAt).toBe(AT);
  });

  it('OTRO usuario sin manage → Forbidden (no toca la nota)', async () => {
    const { messageRepo, conv, uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });

    await expect(uc.execute(conv.id, note.id, 'hack', { userId: 'intruso', hasManage: false })).rejects.toBeInstanceOf(
      InternalNoteForbiddenError,
    );
    const stored = await messageRepo.findById(note.id);
    expect(stored!.content).toBe('nota original');
    expect(stored!.editedAt).toBeNull();
  });

  it('SUPERVISOR (hasManage) que no es el autor → OK', async () => {
    const { conv, uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });

    const dto = await uc.execute(conv.id, note.id, 'moderada por supervisor', { userId: 'supervisor', hasManage: true });
    expect(dto.content).toBe('moderada por supervisor');
  });

  it('nota con authorId NULL → sólo el supervisor puede (autor desconocido)', async () => {
    const { conv, uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: null });

    await expect(uc.execute(conv.id, note.id, 'x', { userId: 'cualquiera', hasManage: false })).rejects.toBeInstanceOf(
      InternalNoteForbiddenError,
    );
    const dto = await uc.execute(conv.id, note.id, 'editada por super', { userId: 'super', hasManage: true });
    expect(dto.content).toBe('editada por super');
  });

  it('editar un mensaje PÚBLICO (isPrivate:false) → NotAnInternalNote', async () => {
    const { conv, uc, seedNote } = await harness();
    const pub = await seedNote({ chatwootMessageId: 1, isPrivate: false, authorId: null });

    await expect(uc.execute(conv.id, pub.id, 'x', { userId: 'super', hasManage: true })).rejects.toBeInstanceOf(
      NotAnInternalNoteError,
    );
  });

  it('editar una nota YA borrada → AlreadyDeleted', async () => {
    const { messageRepo, conv, uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });
    await messageRepo.softDelete(note.id, AT);

    await expect(uc.execute(conv.id, note.id, 'x', { userId: 'author-1', hasManage: false })).rejects.toBeInstanceOf(
      InternalNoteAlreadyDeletedError,
    );
  });

  it('messageId inexistente → NotFound', async () => {
    const { conv, uc } = await harness();
    await expect(uc.execute(conv.id, 'ghost', 'x', { userId: 'author-1', hasManage: false })).rejects.toBeInstanceOf(
      InternalNoteNotFoundError,
    );
  });

  // LOW-2 — la nota debe pertenecer a la conversación del path.
  it('nota de OTRA conversación → NotFound (no revela que existe en otra conversación)', async () => {
    const { conversationRepo, conv, uc, seedNote } = await harness();
    const otra = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 2 });
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' }); // vive en conv, no en `otra`

    await expect(uc.execute(otra.id, note.id, 'x', { userId: 'author-1', hasManage: false })).rejects.toBeInstanceOf(
      InternalNoteNotFoundError,
    );
    // control: en su propia conversación sí resuelve
    const dto = await uc.execute(conv.id, note.id, 'ok', { userId: 'author-1', hasManage: false });
    expect(dto.content).toBe('ok');
  });

  // LOW-3 — TOCTOU: updateContent devuelve null (borrada entre findById y update) → NotFound, no 500.
  it('updateContent devuelve null (carrera TOCTOU) → NotFound', async () => {
    const { conv, seedNote, messageRepo } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });
    jest.spyOn(messageRepo, 'updateContent').mockResolvedValueOnce(null);
    const uc = new EditInternalNote(messageRepo, () => new Date(AT));

    await expect(uc.execute(conv.id, note.id, 'x', { userId: 'author-1', hasManage: false })).rejects.toBeInstanceOf(
      InternalNoteNotFoundError,
    );
  });

  it('editar NO cambia internalNoteCount (no crea ni borra notas)', async () => {
    const { conversationRepo, conv, uc, seedNote } = await harness();
    const note = await seedNote({ chatwootMessageId: 1, authorId: 'author-1' });
    expect((await conversationRepo.findById(conv.id))!.internalNoteCount).toBe(1);

    await uc.execute(conv.id, note.id, 'editada', { userId: 'author-1', hasManage: false });
    expect((await conversationRepo.findById(conv.id))!.internalNoteCount).toBe(1);
  });
});
