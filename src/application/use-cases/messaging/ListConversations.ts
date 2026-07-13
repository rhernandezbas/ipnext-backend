import type { ConversationRepository, ConversationListQuery } from '@domain/ports/ConversationRepository';
import type { PaginatedResult } from '@application/dto/pagination';
import { toConversationListItemDto, type ConversationListItemDto } from '@application/dto/messaging';

/**
 * ListConversations (F1, design §4/§8, INBOX-1) — paginated inbox listing, ordered
 * by `lastMessageAt` DESC (sort itself lives in the repository, same contract as
 * `ListClients`/`dto/pagination.ts` — NOT the custom `page/pageSize` actions-worklist
 * used). Deliberately does NOT compute `clientContext` per row (design §1: that would
 * re-run `listActiveContacts()` once per conversation, an N+1 the explore phase
 * flagged) — client context is only computed on conversation DETAIL (`GetConversation`).
 */
export class ListConversations {
  constructor(private readonly conversationRepo: ConversationRepository) {}

  async execute(query: ConversationListQuery): Promise<PaginatedResult<ConversationListItemDto>> {
    const result = await this.conversationRepo.list(query);
    return {
      ...result,
      data: result.data.map(toConversationListItemDto),
    };
  }
}
