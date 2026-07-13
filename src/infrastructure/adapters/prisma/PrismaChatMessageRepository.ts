import {
  ChatMessageRepository,
  ChatMessageRecord,
  UpsertChatMessageInput,
} from '@domain/ports/ChatMessageRepository';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value instanceof Date ? value.toISOString() : (value as string);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDomain(row: any): ChatMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    chatwootMessageId: row.chatwootMessageId,
    direction: row.direction,
    content: row.content,
    senderName: row.senderName ?? null,
    chatwootCreatedAt: toIso(row.chatwootCreatedAt),
    createdAt: toIso(row.createdAt),
    isPrivate: row.isPrivate ?? false,
  };
}

/**
 * messaging-inbox (F1) — Prisma adapter for `ChatMessageRepository`.
 * Not unit-tested (design/tasks §B2): the contract is exercised via the
 * in-memory port in use-case tests; this adapter is verified in integration.
 */
export class PrismaChatMessageRepository implements ChatMessageRepository {
  async upsertByChatwootMessageId(input: UpsertChatMessageInput): Promise<ChatMessageRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).chatMessage.upsert({
      where: { chatwootMessageId: input.chatwootMessageId },
      create: {
        conversationId: input.conversationId,
        chatwootMessageId: input.chatwootMessageId,
        direction: input.direction,
        content: input.content,
        senderName: input.senderName ?? null,
        chatwootCreatedAt: new Date(input.chatwootCreatedAt),
        isPrivate: input.isPrivate ?? false,
      },
      update: {
        conversationId: input.conversationId,
        direction: input.direction,
        content: input.content,
        senderName: input.senderName ?? null,
        chatwootCreatedAt: new Date(input.chatwootCreatedAt),
        isPrivate: input.isPrivate ?? false,
      },
    });
    return toDomain(row);
  }

  async listByConversation(conversationId: string): Promise<ChatMessageRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).chatMessage.findMany({
      where: { conversationId },
      // INBOX-3: oldest first. `id` ASC is a §8 tiebreaker — Postgres gives NO
      // guarantee on row order for `chatwootCreatedAt` ties without a secondary
      // ORDER BY key; MUST mirror `InMemoryChatMessageRepository.listByConversation`'s
      // comparator exactly.
      orderBy: [{ chatwootCreatedAt: 'asc' }, { id: 'asc' }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => toDomain(r));
  }

  async findById(id: string): Promise<ChatMessageRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).chatMessage.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }
}
