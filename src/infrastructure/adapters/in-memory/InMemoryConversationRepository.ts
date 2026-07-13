import { randomUUID } from 'crypto';
import { PaginatedResult } from '@application/dto/pagination';
import {
  ConversationRepository,
  ConversationRecord,
  ConversationListQuery,
  UpsertConversationInput,
  UpdateConversationLocalFieldsInput,
} from '@domain/ports/ConversationRepository';
import { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';

/** Minimal in-memory user shape for JOIN-derived assigneeName (F1.5-C2) — mirrors
 * InMemoryTicketRepository's InMemoryAdmin. */
export interface InMemoryConversationAssignee {
  id: string;
  name: string;
}

/**
 * In-memory ConversationRepository for use-case and route tests.
 * `upsertByChatwootId` mirrors the Prisma `upsert()` on the unique
 * `chatwootConversationId` — create fills schema defaults for unset fields,
 * update only touches fields explicitly present in the input (undefined = untouched).
 *
 * F1.5-C2 (asignación) — `assigneeId`/`areaId` are LOCAL-only fields. They are
 * NEVER touched by `upsertByChatwootId` (its `create`/update branches simply
 * never reference them, same "undefined = untouched" convention already
 * governing the Chatwoot-sourced fields) — only `updateLocalFields` writes them.
 */
export class InMemoryConversationRepository implements ConversationRepository {
  private rows: ConversationRecord[] = [];
  private users: Map<string, InMemoryConversationAssignee> = new Map();
  private areaRepo: TicketAreaCatalogRepository | null = null;

  /** Seed users so the repo can resolve assigneeName from JOIN (F1.5-C2). */
  seedUsers(users: InMemoryConversationAssignee[]): void {
    for (const u of users) {
      this.users.set(u.id, u);
    }
  }

  /** Link a shared TicketAreaCatalogRepository so areaName/areaColor resolve via JOIN (F1.5-C2). */
  seedAreas(repo: TicketAreaCatalogRepository): void {
    this.areaRepo = repo;
  }

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
      // F1.5-C2 — assigneeId/areaId/assigneeName/areaName/areaColor are DELIBERATELY
      // absent from this branch: this method must never touch them (LOCAL-only fields).
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
      // F1.5-C2 — LOCAL-only, always null on create (never set from Chatwoot input).
      assigneeId: null,
      assigneeName: null,
      areaId: null,
      areaName: null,
      areaColor: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return { ...row };
  }

  /** F1.5-C2 (asignación) — actualiza EXCLUSIVAMENTE assigneeId/areaId (LOCAL). */
  async updateLocalFields(
    conversationId: string,
    patch: UpdateConversationLocalFieldsInput,
  ): Promise<ConversationRecord | null> {
    const row = this.rows.find((r) => r.id === conversationId);
    if (!row) return null;

    if (patch.assigneeId !== undefined) {
      row.assigneeId = patch.assigneeId;
      row.assigneeName = patch.assigneeId ? (this.users.get(patch.assigneeId)?.name ?? null) : null;
    }
    if (patch.areaId !== undefined) {
      row.areaId = patch.areaId;
      if (patch.areaId && this.areaRepo) {
        const area = await this.areaRepo.getById(patch.areaId);
        row.areaName = area?.name ?? null;
        row.areaColor = area?.color ?? null;
      } else {
        row.areaName = null;
        row.areaColor = null;
      }
    }
    row.updatedAt = new Date().toISOString();
    return { ...row };
  }

  async list(query: ConversationListQuery): Promise<PaginatedResult<ConversationRecord>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;

    // F1.5-C2 — assignment filter (Mine/Unassigned/All). `assigneeId` truthy wins
    // over `unassigned` if both were somehow set (same precedence documented on
    // the port), mirroring PrismaConversationRepository.list's `where` construction.
    let filtered = this.rows;
    if (query.assigneeId) {
      filtered = filtered.filter((r) => r.assigneeId === query.assigneeId);
    } else if (query.unassigned) {
      filtered = filtered.filter((r) => r.assigneeId === null);
    }

    // INBOX-1: lastMessageAt DESC, nulls (never messaged) sorted last, id ASC as a
    // tiebreaker (§8). Postgres gives NO guarantee on row order for ties without a
    // secondary ORDER BY key — this MUST mirror `PrismaConversationRepository.list`'s
    // `orderBy` array exactly, or the in-memory fake (whose stable Array.sort would
    // otherwise just preserve insertion order) masks an instability prod actually has.
    const sorted = filtered.slice().sort((a, b) => {
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
