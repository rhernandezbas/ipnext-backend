import {
  ChatMessageRepository,
  ChatMessageRecord,
  UpsertChatMessageInput,
  UpsertBulkChatMessageInput,
  UpsertTemplateChatMessageInput,
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
    chatwootMessageId: row.chatwootMessageId ?? null,
    origin: row.origin ?? 'chatwoot',
    campaignRecipientId: row.campaignRecipientId ?? null,
    direction: row.direction,
    content: row.content,
    senderName: row.senderName ?? null,
    chatwootCreatedAt: toIso(row.chatwootCreatedAt),
    createdAt: toIso(row.createdAt),
    isPrivate: row.isPrivate ?? false,
    providerMessageId: row.providerMessageId ?? null,
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

  /**
   * messaging-bulk-inbox (F1, PROYECCIÓN) — idempotente por `campaignRecipientId`
   * (@unique). Un mensaje `outbound`/`origin:'bulk'`/`chatwootMessageId:null`.
   * Re-proyectar el mismo recipient actualiza la fila, NUNCA duplica.
   */
  async upsertBulkMessage(input: UpsertBulkChatMessageInput): Promise<ChatMessageRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).chatMessage.upsert({
      where: { campaignRecipientId: input.campaignRecipientId },
      create: {
        conversationId: input.conversationId,
        chatwootMessageId: null,
        origin: 'bulk',
        campaignRecipientId: input.campaignRecipientId,
        direction: 'outbound',
        content: input.content,
        senderName: input.senderName ?? null,
        chatwootCreatedAt: new Date(input.chatwootCreatedAt),
        isPrivate: false,
      },
      update: {
        conversationId: input.conversationId,
        content: input.content,
        senderName: input.senderName ?? null,
        chatwootCreatedAt: new Date(input.chatwootCreatedAt),
      },
    });
    return toDomain(row);
  }

  /**
   * inbox-template-send (PORT-1) — idempotente por `providerMessageId` (`@unique`,
   * SM sid de Twilio). Un mensaje `outbound`/`origin:'agent_template'`/
   * `chatwootMessageId:null`/`campaignRecipientId:null`. Cross-ref: MISMA semántica
   * que `InMemoryChatMessageRepository.upsertTemplateMessage` — no pueden divergir.
   */
  async upsertTemplateMessage(input: UpsertTemplateChatMessageInput): Promise<ChatMessageRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).chatMessage.upsert({
      where: { providerMessageId: input.providerMessageId },
      create: {
        conversationId: input.conversationId,
        chatwootMessageId: null,
        origin: 'agent_template',
        campaignRecipientId: null,
        providerMessageId: input.providerMessageId,
        direction: 'outbound',
        content: input.content,
        senderName: input.senderName ?? null,
        chatwootCreatedAt: new Date(input.chatwootCreatedAt),
        isPrivate: false,
      },
      update: {
        conversationId: input.conversationId,
        content: input.content,
        senderName: input.senderName ?? null,
        chatwootCreatedAt: new Date(input.chatwootCreatedAt),
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
