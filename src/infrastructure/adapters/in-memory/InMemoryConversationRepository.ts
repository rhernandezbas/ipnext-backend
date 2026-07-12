import { randomUUID } from 'crypto';
import { PaginatedQuery, PaginatedResult } from '@application/dto/pagination';
import {
  ConversationRepository,
  ConversationRecord,
  UpsertConversationInput,
} from '@domain/ports/ConversationRepository';

/**
 * In-memory ConversationRepository for use-case and route tests.
 * `upsertByChatwootId` mirrors the Prisma `upsert()` on the unique
 * `chatwootConversationId` — create fills schema defaults for unset fields,
 * update only touches fields explicitly present in the input (undefined = untouched).
 */
export class InMemoryConversationRepository implements ConversationRepository {
  private rows: ConversationRecord[] = [];

  async findById(id: string): Promise<ConversationRecord | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  async findByChatwootId(chatwootConversationId: number): Promise<ConversationRecord | null> {
    const row = this.rows.find((r) => r.chatwootConversationId === chatwootConversationId);
    return row ? { ...row } : null;
  }

  async upsertByChatwootId(input: UpsertConversationInput): Promise<ConversationRecord> {
    const existing = this.rows.find((r) => r.chatwootConversationId === input.chatwootConversationId);
    if (existing) {
      if (input.contactName !== undefined) existing.contactName = input.contactName;
      if (input.contactPhone !== undefined) existing.contactPhone = input.contactPhone;
      if (input.status !== undefined) existing.status = input.status;
      if (input.canReply !== undefined) existing.canReply = input.canReply;
      if (input.lastMessageAt !== undefined) existing.lastMessageAt = input.lastMessageAt;
      if (input.lastMessagePreview !== undefined) existing.lastMessagePreview = input.lastMessagePreview;
      existing.updatedAt = new Date().toISOString();
      return { ...existing };
    }

    const now = new Date().toISOString();
    const row: ConversationRecord = {
      id: randomUUID(),
      chatwootConversationId: input.chatwootConversationId,
      contactName: input.contactName ?? null,
      contactPhone: input.contactPhone ?? null,
      status: input.status ?? 'open',
      canReply: input.canReply ?? false,
      lastMessageAt: input.lastMessageAt ?? null,
      lastMessagePreview: input.lastMessagePreview ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return { ...row };
  }

  async list(query: PaginatedQuery): Promise<PaginatedResult<ConversationRecord>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;

    // INBOX-1: lastMessageAt DESC, nulls (never messaged) sorted last, id ASC as a
    // tiebreaker (§8). Postgres gives NO guarantee on row order for ties without a
    // secondary ORDER BY key — this MUST mirror `PrismaConversationRepository.list`'s
    // `orderBy` array exactly, or the in-memory fake (whose stable Array.sort would
    // otherwise just preserve insertion order) masks an instability prod actually has.
    const sorted = this.rows.slice().sort((a, b) => {
      if (a.lastMessageAt === null && b.lastMessageAt === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      if (a.lastMessageAt === null) return 1;
      if (b.lastMessageAt === null) return -1;
      if (a.lastMessageAt !== b.lastMessageAt) return a.lastMessageAt < b.lastMessageAt ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const total = sorted.length;
    const data = sorted.slice((page - 1) * limit, (page - 1) * limit + limit).map((r) => ({ ...r }));

    return { data, total, page, limit };
  }
}
