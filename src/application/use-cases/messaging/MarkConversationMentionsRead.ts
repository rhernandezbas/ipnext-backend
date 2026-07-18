import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ConversationMentionRepository } from '@domain/ports/ConversationMentionRepository';
import { ConversationNotFoundError } from '@domain/errors/messaging';

/**
 * note-mentions (Ola 6b) — marca como leídas las @menciones del usuario ACTUAL en una
 * conversación, para que salga de su vista "Menciones" al abrirla (POST
 * `/conversations/:id/mentions/read`).
 *
 * Guard order:
 *   1. `conversationRepo.findById` → `ConversationNotFoundError` (404) — mismo error/criterio
 *      que el resto del router (una conversación fantasma no marca nada).
 *   2. `mentionRepo.markReadForUser` → setea `readAt=now` a TODAS las menciones NO leídas del
 *      user en esa conversación. Idempotente (marcar dos veces devuelve 0 la segunda).
 *
 * Devuelve `{ markedRead }` (cuántas marcó) — el FE usa 0/>0 para refrescar el badge.
 */
export interface MarkMentionsReadResult {
  markedRead: number;
}

export class MarkConversationMentionsRead {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly mentionRepo: ConversationMentionRepository,
  ) {}

  async execute(conversationId: string, userId: string): Promise<MarkMentionsReadResult> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    const markedRead = await this.mentionRepo.markReadForUser(
      conversationId,
      userId,
      new Date().toISOString(),
    );
    return { markedRead };
  }
}
