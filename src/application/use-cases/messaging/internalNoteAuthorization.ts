import type { ChatMessageRecord } from '@domain/ports/ChatMessageRepository';
import { actorMayMutateNote } from '@application/dto/messaging';
import {
  NotAnInternalNoteError,
  InternalNoteAlreadyDeletedError,
  InternalNoteForbiddenError,
} from '@domain/errors/messaging';

/**
 * messaging-inbox-notes (edit/delete) — actor de una mutación de nota interna.
 * `userId` = req.user.id autenticado; `hasManage` = tiene `messaging:manage` (supervisor).
 */
export interface InternalNoteActor {
  userId: string;
  hasManage: boolean;
}

/**
 * messaging-inbox-notes (edit/delete) — guard COMPARTIDO por EditInternalNote y
 * DeleteInternalNote (ÚNICA fuente de verdad de la validación de estado + autorización).
 * El caller ya resolvió la existencia (findById → InternalNoteNotFoundError). Acá, en el
 * ORDEN fijado por el spec:
 *   1. NO es una nota interna (isPrivate=false) → NotAnInternalNoteError (422).
 *   2. ya soft-deleted (deletedAt != null) → InternalNoteAlreadyDeletedError (409).
 *   3. no es el autor NI supervisor → InternalNoteForbiddenError (403). Si authorId es
 *      NULL (nota histórica / autor desasociado) sólo el supervisor pasa.
 */
export function assertInternalNoteMutable(record: ChatMessageRecord, actor: InternalNoteActor): void {
  if (!record.isPrivate) throw new NotAnInternalNoteError(record.id);
  if (record.deletedAt !== null) throw new InternalNoteAlreadyDeletedError(record.id);
  if (!actorMayMutateNote(record.authorId, { userId: actor.userId, canManage: actor.hasManage })) {
    throw new InternalNoteForbiddenError(record.id);
  }
}
