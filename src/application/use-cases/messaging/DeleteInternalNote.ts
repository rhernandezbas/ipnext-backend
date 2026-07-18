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
 * authorId NULL → sólo supervisor): existe (404) → es nota interna (422) → NO ya
 * borrada (409) → autorizado (403).
 */
export class DeleteInternalNote {
  constructor(
    private readonly messageRepo: ChatMessageRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(messageId: string, actor: InternalNoteActor): Promise<ChatMessageDto> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new InternalNoteNotFoundError(messageId);

    assertInternalNoteMutable(message, actor);

    const deletedAt = this.now().toISOString();
    const updated = await this.messageRepo.softDelete(messageId, deletedAt);
    const record = updated ?? { ...message, deletedAt };
    // DTO: deleted=true, content vacío (el mapper lo blankea) — el FE muestra el tombstone.
    return toChatMessageDto(record, [], { userId: actor.userId, canManage: actor.hasManage });
  }
}
