import { randomUUID } from 'crypto';
import {
  ChatMessageRepository,
  ChatMessageRecord,
  UpsertChatMessageInput,
} from '@domain/ports/ChatMessageRepository';

/**
 * In-memory ChatMessageRepository for use-case and route tests.
 * Dedup key mirrors the Prisma `@unique` on `chatwootMessageId` (HOOK-4/INBOX-2).
 */
export class InMemoryChatMessageRepository implements ChatMessageRepository {
  private rows: ChatMessageRecord[] = [];

  async upsertByChatwootMessageId(input: UpsertChatMessageInput): Promise<ChatMessageRecord> {
    const existing = this.rows.find((r) => r.chatwootMessageId === input.chatwootMessageId);
    if (existing) {
      existing.conversationId = input.conversationId;
      existing.direction = input.direction;
      existing.content = input.content;
      existing.senderName = input.senderName ?? null;
      existing.chatwootCreatedAt = input.chatwootCreatedAt;
      return { ...existing };
    }

    const row: ChatMessageRecord = {
      id: randomUUID(),
      conversationId: input.conversationId,
      chatwootMessageId: input.chatwootMessageId,
      direction: input.direction,
      content: input.content,
      senderName: input.senderName ?? null,
      chatwootCreatedAt: input.chatwootCreatedAt,
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async listByConversation(conversationId: string): Promise<ChatMessageRecord[]> {
    // INBOX-3: chatwootCreatedAt ASC, id ASC as a tiebreaker (§8) — MUST mirror
    // `PrismaChatMessageRepository.listByConversation`'s `orderBy` array exactly
    // (same rationale as `InMemoryConversationRepository.list`'s tiebreaker).
    return this.rows
      .filter((r) => r.conversationId === conversationId)
      .sort((a, b) => {
        const byDate = a.chatwootCreatedAt.localeCompare(b.chatwootCreatedAt);
        if (byDate !== 0) return byDate;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .map((r) => ({ ...r }));
  }

  async findById(id: string): Promise<ChatMessageRecord | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }
}
