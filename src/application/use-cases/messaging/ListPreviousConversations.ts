import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import { ConversationNotFoundError } from '@domain/errors/messaging';
import { toPreviousConversationDto, type PreviousConversationDto } from '@application/dto/messaging';
import { toWhatsAppE164 } from './toWhatsAppE164';

/** Techo de filas de la lista de previas (Chatwoot's "Previous Conversations" es
 * un panel compacto, no un listado paginado). Sobreescribible en tests. */
const DEFAULT_PREVIOUS_LIMIT = 20;

export interface ListPreviousConversationsOptions {
  limit?: number;
}

/**
 * ListPreviousConversations (previous-conversations, Ola 6a) — lista las OTRAS
 * conversaciones del MISMO contacto para el panel de contexto del inbox
 * (equivalente a Chatwoot's "Previous Conversations"), EXCLUYENDO la conversación
 * actual. Reusa EXACTAMENTE la clave de identidad del contador `convo-count`: el
 * `contactPhoneE164` canónico (`GetInboxClientContext.safeConversationCounts`),
 * con el mismo fallback on-the-fly `toWhatsAppE164(contactPhone)` para filas
 * pre-backfill. Sin clave canónica reconstruible (número foráneo/malformado) →
 * `[]` (jamás agrupar strings crudos heterogéneos — misma "degradación segura"
 * que el contador). Ordena por `lastMessageAt` DESC (lo hace el repo) y trunca a
 * `limit`. DTO liviano (`PreviousConversationDto`) — nunca el record crudo.
 */
export class ListPreviousConversations {
  private readonly limit: number;

  constructor(
    private readonly conversationRepo: ConversationRepository,
    opts: ListPreviousConversationsOptions = {},
  ) {
    this.limit = opts.limit ?? DEFAULT_PREVIOUS_LIMIT;
  }

  async execute(conversationId: string): Promise<PreviousConversationDto[]> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    const phoneE164 = conversation.contactPhoneE164 ?? toWhatsAppE164(conversation.contactPhone);
    if (phoneE164 === null) return [];

    const others = await this.conversationRepo.listByContactPhoneE164(
      phoneE164,
      conversationId,
      this.limit,
    );
    return others.map(toPreviousConversationDto);
  }
}
