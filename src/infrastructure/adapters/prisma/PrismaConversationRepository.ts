import {
  ConversationRepository,
  ConversationRecord,
  UpsertConversationInput,
} from '@domain/ports/ConversationRepository';
import { PaginatedQuery, PaginatedResult } from '@application/dto/pagination';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string | null {
  if (value instanceof Date) return value.toISOString();
  return (value as string | null) ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDomain(row: any): ConversationRecord {
  return {
    id: row.id,
    chatwootConversationId: row.chatwootConversationId,
    contactName: row.contactName ?? null,
    contactPhone: row.contactPhone ?? null,
    status: row.status,
    canReply: row.canReply,
    lastMessageAt: toIso(row.lastMessageAt),
    lastMessagePreview: row.lastMessagePreview ?? null,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

/** Builds the `update` clause — only fields explicitly present in `input` are touched (design §4). */
function updateData(input: UpsertConversationInput): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (input.contactName !== undefined) data['contactName'] = input.contactName;
  if (input.contactPhone !== undefined) data['contactPhone'] = input.contactPhone;
  if (input.status !== undefined) data['status'] = input.status;
  if (input.canReply !== undefined) data['canReply'] = input.canReply;
  if (input.lastMessageAt !== undefined) {
    data['lastMessageAt'] = input.lastMessageAt === null ? null : new Date(input.lastMessageAt);
  }
  if (input.lastMessagePreview !== undefined) data['lastMessagePreview'] = input.lastMessagePreview;
  return data;
}

/**
 * messaging-inbox (F1) — Prisma adapter for `ConversationRepository`.
 * Not unit-tested (design/tasks §B2): the contract is exercised via the
 * in-memory port in use-case tests; this adapter is verified in integration.
 */
export class PrismaConversationRepository implements ConversationRepository {
  async findById(id: string): Promise<ConversationRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).conversation.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async findByChatwootId(chatwootConversationId: number): Promise<ConversationRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).conversation.findUnique({ where: { chatwootConversationId } });
    return row ? toDomain(row) : null;
  }

  async upsertByChatwootId(input: UpsertConversationInput): Promise<ConversationRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).conversation.upsert({
      where: { chatwootConversationId: input.chatwootConversationId },
      create: {
        chatwootConversationId: input.chatwootConversationId,
        contactName: input.contactName ?? null,
        contactPhone: input.contactPhone ?? null,
        status: input.status ?? 'open',
        canReply: input.canReply ?? false,
        lastMessageAt: input.lastMessageAt ? new Date(input.lastMessageAt) : null,
        lastMessagePreview: input.lastMessagePreview ?? null,
      },
      update: updateData(input),
    });
    return toDomain(row);
  }

  async list(query: PaginatedQuery): Promise<PaginatedResult<ConversationRecord>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;

    const [rows, total] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prisma as any).conversation.findMany({
        // INBOX-1: most recent first, never-messaged conversations (lastMessageAt null)
        // sort last. `id` ASC is a §8 tiebreaker — Postgres gives NO guarantee on row
        // order for `lastMessageAt` ties without a secondary ORDER BY key; MUST mirror
        // `InMemoryConversationRepository.list`'s comparator exactly.
        orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prisma as any).conversation.count(),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { data: rows.map((r: any) => toDomain(r)), total, page, limit };
  }
}
