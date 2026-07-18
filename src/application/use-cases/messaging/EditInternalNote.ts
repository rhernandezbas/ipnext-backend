import type { ChatMessageRepository } from '@domain/ports/ChatMessageRepository';
import { InternalNoteNotFoundError } from '@domain/errors/messaging';
import { toChatMessageDto, type ChatMessageDto } from '@application/dto/messaging';
import { assertInternalNoteMutable, type InternalNoteActor } from './internalNoteAuthorization';

/**
 * EditInternalNote (messaging-inbox-notes, edit/delete) — edita el contenido de una
 * nota interna (`isPrivate`). Autorización: el AUTOR (authorId === actor.userId) O un
 * SUPERVISOR (actor.hasManage). Si `authorId` es NULL (nota histórica) sólo el supervisor.
 *
 * Guard order (spec): existe (404) → es nota interna (422) → NO borrada (409) →
 * autorizado (403). Sólo entonces persiste `content` + `editedAt=now`. Editar NO cambia
 * el `internalNoteCount` (no crea ni borra notas).
 *
 * `now` inyectable (clock testeable, mismo criterio que el resto del repo).
 */
export class EditInternalNote {
  constructor(
    private readonly messageRepo: ChatMessageRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(messageId: string, newContent: string, actor: InternalNoteActor): Promise<ChatMessageDto> {
    const message = await this.messageRepo.findById(messageId);
    if (!message) throw new InternalNoteNotFoundError(messageId);

    assertInternalNoteMutable(message, actor);

    const updated = await this.messageRepo.updateContent(messageId, newContent, this.now().toISOString());
    // updated no puede ser null: findById ya confirmó existencia y nadie borra la fila.
    const record = updated ?? { ...message, content: newContent, editedAt: this.now().toISOString() };
    return toChatMessageDto(record, [], { userId: actor.userId, canManage: actor.hasManage });
  }
}
