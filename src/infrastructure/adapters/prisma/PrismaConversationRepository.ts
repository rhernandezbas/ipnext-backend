import {
  ConversationRepository,
  ConversationRecord,
  ConversationListQuery,
  UpsertConversationInput,
  UpdateConversationLocalFieldsInput,
} from '@domain/ports/ConversationRepository';
import { PaginatedResult } from '@application/dto/pagination';
import { prisma } from '../../database/prisma';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string | null {
  if (value instanceof Date) return value.toISOString();
  return (value as string | null) ?? null;
}

/**
 * F1.5-C2 (asignación) — shared `include` for assignee/area JOIN-derived fields.
 * Every read/write method below MUST pass this so `toDomain` always has
 * `row.assignee`/`row.area` available (even when both are null).
 */
const CONVERSATION_INCLUDE = {
  assignee: { select: { id: true, name: true } },
  area: { select: { id: true, name: true, color: true } },
} as const;

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
    // F1.5-C2 — assigneeId/areaId are the FK scalars (always present on the row);
    // assigneeName/areaName/areaColor are JOIN-derived from CONVERSATION_INCLUDE.
    assigneeId: row.assigneeId ?? null,
    assigneeName: row.assignee?.name ?? null,
    areaId: row.areaId ?? null,
    areaName: row.area?.name ?? null,
    areaColor: row.area?.color ?? null,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

/**
 * Builds the `update` clause — only fields explicitly present in `input` are
 * touched (design §4). F1.5-C2 — deliberately NEVER references assigneeId/areaId:
 * this is the entire mechanism that keeps `upsertByChatwootId` (webhook/fetch-on-open/
 * SendMessage/SetConversationStatus) from ever pisando the LOCAL assignment fields.
 */
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
    const row = await (prisma as any).conversation.findUnique({ where: { id }, include: CONVERSATION_INCLUDE });
    return row ? toDomain(row) : null;
  }

  async findByChatwootId(chatwootConversationId: number): Promise<ConversationRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).conversation.findUnique({
      where: { chatwootConversationId },
      include: CONVERSATION_INCLUDE,
    });
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
        // F1.5-C2 — assigneeId/areaId deliberately absent: schema default (null),
        // never set from Chatwoot-sourced input.
      },
      update: updateData(input),
      include: CONVERSATION_INCLUDE,
    });
    return toDomain(row);
  }

  /** F1.5-C2 (asignación) — actualiza EXCLUSIVAMENTE assigneeId/areaId (LOCAL, sin Chatwoot). */
  async updateLocalFields(
    conversationId: string,
    patch: UpdateConversationLocalFieldsInput,
  ): Promise<ConversationRecord | null> {
    const data: Record<string, unknown> = {};
    if (patch.assigneeId !== undefined) data['assigneeId'] = patch.assigneeId;
    if (patch.areaId !== undefined) data['areaId'] = patch.areaId;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).conversation.update({
        where: { id: conversationId },
        data,
        include: CONVERSATION_INCLUDE,
      });
      return toDomain(row);
    } catch (err) {
      // P2025 = record not found — the use case already validates existence via
      // findById before calling this, so this branch is defense-in-depth, not
      // the primary contract (mirrors the "return null on miss" convention).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((err as any)?.code === 'P2025') return null;
      throw err;
    }
  }

  async list(query: ConversationListQuery): Promise<PaginatedResult<ConversationRecord>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;

    // F1.5-C2 — assignment filter (Mine/Unassigned/All). `assigneeId` truthy wins
    // over `unassigned` (same precedence as InMemoryConversationRepository.list).
    const where: Record<string, unknown> = {};
    if (query.assigneeId) {
      where['assigneeId'] = query.assigneeId;
    } else if (query.unassigned) {
      where['assigneeId'] = null;
    }

    const [rows, total] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prisma as any).conversation.findMany({
        where,
        include: CONVERSATION_INCLUDE,
        // INBOX-1: most recent first, never-messaged conversations (lastMessageAt null)
        // sort last. `id` ASC is a §8 tiebreaker — Postgres gives NO guarantee on row
        // order for `lastMessageAt` ties without a secondary ORDER BY key; MUST mirror
        // `InMemoryConversationRepository.list`'s comparator exactly.
        orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prisma as any).conversation.count({ where }),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { data: rows.map((r: any) => toDomain(r)), total, page, limit };
  }
}
