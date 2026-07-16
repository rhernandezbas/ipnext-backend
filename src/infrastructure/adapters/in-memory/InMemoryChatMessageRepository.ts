import { randomUUID } from 'crypto';
import {
  ChatMessageRepository,
  ChatMessageRecord,
  UpsertChatMessageInput,
  UpsertBulkChatMessageInput,
  UpsertTemplateChatMessageInput,
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
      existing.isPrivate = input.isPrivate ?? false;
      return { ...existing };
    }

    const row: ChatMessageRecord = {
      id: randomUUID(),
      conversationId: input.conversationId,
      chatwootMessageId: input.chatwootMessageId,
      origin: 'chatwoot',
      campaignRecipientId: null,
      direction: input.direction,
      content: input.content,
      senderName: input.senderName ?? null,
      chatwootCreatedAt: input.chatwootCreatedAt,
      isPrivate: input.isPrivate ?? false,
      createdAt: new Date().toISOString(),
      providerMessageId: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  /**
   * messaging-bulk-inbox (F1, PROYECCIÓN) — idempotente por `campaignRecipientId`.
   * Un mensaje `outbound`/`origin:'bulk'`/`chatwootMessageId:null`. Re-proyectar el
   * mismo recipient actualiza la fila existente, NUNCA duplica.
   */
  async upsertBulkMessage(input: UpsertBulkChatMessageInput): Promise<ChatMessageRecord> {
    const existing = this.rows.find((r) => r.campaignRecipientId === input.campaignRecipientId);
    if (existing) {
      existing.conversationId = input.conversationId;
      existing.content = input.content;
      existing.chatwootCreatedAt = input.chatwootCreatedAt;
      existing.senderName = input.senderName ?? null;
      return { ...existing };
    }

    const row: ChatMessageRecord = {
      id: randomUUID(),
      conversationId: input.conversationId,
      chatwootMessageId: null,
      origin: 'bulk',
      campaignRecipientId: input.campaignRecipientId,
      direction: 'outbound',
      content: input.content,
      senderName: input.senderName ?? null,
      chatwootCreatedAt: input.chatwootCreatedAt,
      isPrivate: false,
      createdAt: new Date().toISOString(),
      providerMessageId: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  /**
   * inbox-template-send (PORT-1) — idempotente por `providerMessageId` (SM sid de
   * Twilio). Un mensaje `outbound`/`origin:'agent_template'`/`chatwootMessageId:null`/
   * `campaignRecipientId:null`. Re-proyectar el MISMO sid actualiza la fila, NUNCA duplica.
   */
  async upsertTemplateMessage(input: UpsertTemplateChatMessageInput): Promise<ChatMessageRecord> {
    const existing = this.rows.find((r) => r.providerMessageId === input.providerMessageId);
    if (existing) {
      existing.conversationId = input.conversationId;
      existing.content = input.content;
      existing.senderName = input.senderName ?? null;
      existing.chatwootCreatedAt = input.chatwootCreatedAt;
      return { ...existing };
    }

    const row: ChatMessageRecord = {
      id: randomUUID(),
      conversationId: input.conversationId,
      chatwootMessageId: null,
      origin: 'agent_template',
      campaignRecipientId: null,
      direction: 'outbound',
      content: input.content,
      senderName: input.senderName ?? null,
      chatwootCreatedAt: input.chatwootCreatedAt,
      isPrivate: false,
      createdAt: new Date().toISOString(),
      providerMessageId: input.providerMessageId,
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
