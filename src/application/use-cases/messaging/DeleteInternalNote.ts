import type { ChatMessageRepository } from '@domain/ports/ChatMessageRepository';
import { InternalNoteNotFoundError } from '@domain/errors/messaging';
import { toChatMessageDto, type ChatMessageDto } from '@application/dto/messaging';
import { assertInternalNoteMutable, type InternalNoteActor } from './internalNoteAuthorization';

/**
 * DeleteInternalNote (messaging-inbox-notes, edit/delete) — SOFT-delete de una nota
 * interna: setea `deletedAt`, NUNCA borra la fila (el hilo la sigue devolviendo con
 * deleted=true → tombstone en el FE). Recalcula `internalNoteCount` (choke point del
 * repo, la nota borrada deja de contar).
 *
 * MISMA autorización y MISMO orden de guards que EditInternalNote (autor O supervisor;
 * authorId NULL → sólo supervisor): existe + pertenece a la conversación del path (404) →
 * es nota interna (422) → NO ya borrada (409) → autorizado (403).
 *
 * LOW-2 — valida que la nota pertenezca a `conversationId` (mismo criterio que
 * EditInternalNote: mismatch → 404, no revela existencia en otra conversación).
 */
export class DeleteInternalNote {
  constructor(
    private readonly messageRepo: ChatMessageRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(conversationId: string, messageId: string, actor: InternalNoteActor): Promise<ChatMessageDto> {
    const message = await this.messageRepo.findById(messageId);
    // LOW-2 — mismo 404 para "no existe" y "existe en otra conversación".
    if (!message || message.conversationId !== conversationId) throw new InternalNoteNotFoundError(messageId);

    assertInternalNoteMutable(message, actor);

    const deletedAt = this.now().toISOString();
    const updated = await this.messageRepo.softDelete(messageId, deletedAt);
    // LOW-3 — TOCTOU: borrada entre findById y update → repo devuelve null → 404, no 500.
    if (!updated) throw new InternalNoteNotFoundError(messageId);
    // DTO: deleted=true, content vacío (el mapper lo blankea) — el FE muestra el tombstone.
    return toChatMessageDto(updated, [], { userId: actor.userId, canManage: actor.hasManage });
  }
}
