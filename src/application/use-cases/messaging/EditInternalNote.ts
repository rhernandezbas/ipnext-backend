import type { ChatMessageRepository } from '@domain/ports/ChatMessageRepository';
import { InternalNoteNotFoundError } from '@domain/errors/messaging';
import { toChatMessageDto, type ChatMessageDto } from '@application/dto/messaging';
import { assertInternalNoteMutable, type InternalNoteActor } from './internalNoteAuthorization';

/**
 * EditInternalNote (messaging-inbox-notes, edit/delete) — edita el contenido de una
 * nota interna (`isPrivate`). Autorización: el AUTOR (authorId === actor.userId) O un
 * SUPERVISOR (actor.hasManage). Si `authorId` es NULL (nota histórica) sólo el supervisor.
 *
 * Guard order (spec): existe + pertenece a la conversación del path (404) → es nota
 * interna (422) → NO borrada (409) → autorizado (403). Sólo entonces persiste `content` +
 * `editedAt=now`. Editar NO cambia el `internalNoteCount` (no crea ni borra notas).
 *
 * LOW-2 — valida que la nota pertenezca a `conversationId` (el `:id` de la URL): sin esto
 * `findById(messageId)` es un lookup GLOBAL y un mensaje de OTRA conversación se editaría
 * vía cualquier `:id`. Un mismatch resuelve el MISMO `InternalNoteNotFoundError` (404) que
 * un id inexistente — no revela que la nota existe en otra conversación.
 *
 * `now` inyectable (clock testeable, mismo criterio que el resto del repo).
 */
export class EditInternalNote {
  constructor(
    private readonly messageRepo: ChatMessageRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(
    conversationId: string,
    messageId: string,
    newContent: string,
    actor: InternalNoteActor,
  ): Promise<ChatMessageDto> {
    const message = await this.messageRepo.findById(messageId);
    // LOW-2 — mismo 404 para "no existe" y "existe en otra conversación" (no filtra info).
    if (!message || message.conversationId !== conversationId) throw new InternalNoteNotFoundError(messageId);

    assertInternalNoteMutable(message, actor);

    const updated = await this.messageRepo.updateContent(messageId, newContent, this.now().toISOString());
    // LOW-3 — TOCTOU: la nota se borró entre el findById y el update → el repo devuelve
    // null (P2025 mapeado a null en el adapter) → 404, NUNCA un 500.
    if (!updated) throw new InternalNoteNotFoundError(messageId);
    return toChatMessageDto(updated, [], { userId: actor.userId, canManage: actor.hasManage });
  }
}
