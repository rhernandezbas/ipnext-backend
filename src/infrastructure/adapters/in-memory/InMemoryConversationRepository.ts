import { randomUUID } from 'crypto';
import { PaginatedResult } from '@application/dto/pagination';
import {
  ConversationRepository,
  ConversationRecord,
  ConversationListQuery,
  ConversationCampaignRef,
  ConversationStatusCounts,
  UpsertConversationInput,
  UpsertBulkConversationInput,
  UpdateConversationLocalFieldsInput,
  BumpLastMessageInput,
} from '@domain/ports/ConversationRepository';
import { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import { toWhatsAppE164 } from '@application/use-cases/messaging/toWhatsAppE164';

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
      // messaging-bulk-inbox (🟠 HIGH) — el write-path de Chatwoot puebla contactPhoneE164
      // así una conversación Chatwoot creada DESPUÉS de la migración es matcheable por el bulk.
      if (input.contactPhone !== undefined) {
        existing.contactPhone = input.contactPhone;
        existing.contactPhoneE164 = toWhatsAppE164(input.contactPhone);
      }
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
      // messaging-bulk-inbox (F1) — el write-path de Chatwoot siempre crea origin='chatwoot'.
      origin: 'chatwoot',
      contactName: input.contactName ?? null,
      contactPhone: input.contactPhone ?? null,
      // messaging-bulk-inbox (🟠 HIGH) — E164 canónico también en el path de Chatwoot.
      contactPhoneE164: toWhatsAppE164(input.contactPhone ?? null),
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
      campaigns: [],
      // inbox-views (VIEW-1) — arranca null (sin mensajes públicos); lo mantiene
      // InMemoryChatMessageRepository vía syncLastPublicMessageDirection.
      lastPublicMessageDirection: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return { ...row };
  }

  /**
   * messaging-bulk-inbox (F1, PROYECCIÓN) — write-path BULK por E164 canónico,
   * SEPARADO de `upsertByChatwootId`. Appendea a la conversación MÁS RECIENTE con ese
   * `phoneE164` (cualquier origen) o crea una `origin:'bulk'` (`chatwootConversationId=null`).
   * Bumpea el preview con el mensaje bulk recién enviado (outbound). NUNCA toca assigneeId/areaId.
   */
  async upsertBulkByPhone(
    phoneE164: string,
    input: UpsertBulkConversationInput,
  ): Promise<ConversationRecord> {
    const matches = this.rows
      .filter((r) => r.contactPhoneE164 === phoneE164)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)); // más reciente primero
    const existing = matches[0];
    if (existing) {
      if (existing.contactName == null && input.contactName != null) existing.contactName = input.contactName;
      if (existing.contactPhone == null && input.contactPhone != null) existing.contactPhone = input.contactPhone;
      if (input.lastMessageAt !== undefined) existing.lastMessageAt = input.lastMessageAt;
      if (input.lastMessagePreview !== undefined) existing.lastMessagePreview = input.lastMessagePreview;
      existing.updatedAt = new Date().toISOString();
      return { ...existing };
    }

    const now = new Date().toISOString();
    const row: ConversationRecord = {
      id: randomUUID(),
      chatwootConversationId: null,
      origin: 'bulk',
      contactName: input.contactName ?? null,
      contactPhone: input.contactPhone ?? null,
      contactPhoneE164: phoneE164,
      status: 'open',
      canReply: false,
      lastMessageAt: input.lastMessageAt ?? null,
      lastMessagePreview: input.lastMessagePreview ?? null,
      assigneeId: null,
      assigneeName: null,
      areaId: null,
      areaName: null,
      areaColor: null,
      campaigns: [],
      // inbox-views (VIEW-1) — null hasta que el write-path de mensajes lo sincronice.
      lastPublicMessageDirection: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return { ...row };
  }

  /**
   * messaging-bulk-inbox (F1, FASE 2 — reconciliación AISLADA) — adopta una
   * conversación `origin:'bulk'` (chatwootConversationId=null) con el mismo
   * `contactPhoneE164` (E164 canónico), seteándole el `chatwootConversationId` in-place
   * (CONSERVA el id). No-op si ese chatwootConversationId ya está tomado o si no
   * hay conversación bulk pendiente. NUNCA toca una conversación Chatwoot existente.
   */
  async adoptBulkConversation(
    phoneE164: string,
    chatwootConversationId: number,
  ): Promise<ConversationRecord | null> {
    // Guard: si alguna conversación YA es dueña de este chatwootConversationId, no-op
    // (sería una conversación Chatwoot existente — jamás tocarla, ni colisionar el UNIQUE).
    if (this.rows.some((r) => r.chatwootConversationId === chatwootConversationId)) return null;

    const target = this.rows
      .filter(
        (r) =>
          r.origin === 'bulk' &&
          r.chatwootConversationId === null &&
          r.contactPhoneE164 === phoneE164,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0]; // más reciente
    if (!target) return null;

    target.chatwootConversationId = chatwootConversationId;
    target.updatedAt = new Date().toISOString();
    return { ...target };
  }

  /**
   * messaging-bulk-inbox (F1, etiqueta #1) — seed de test: simula el JOIN
   * Conversation×CampaignRecipient que el adapter Prisma resuelve por include.
   * Asocia una campaña a una conversación (sin duplicar por id).
   */
  linkCampaign(conversationId: string, campaign: ConversationCampaignRef): void {
    const row = this.rows.find((r) => r.id === conversationId);
    if (!row) return;
    if (!row.campaigns.some((c) => c.id === campaign.id)) row.campaigns.push({ ...campaign });
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

  /**
   * inbox-template-send (PORT-2) — bump del preview tras un envío one-off de
   * template. Escribe EXCLUSIVAMENTE lastMessageAt/lastMessagePreview — jamás
   * canReply/status/assigneeId/areaId/chatwootConversationId/origin (design D2).
   */
  async bumpLastMessage(
    conversationId: string,
    patch: BumpLastMessageInput,
  ): Promise<ConversationRecord | null> {
    const row = this.rows.find((r) => r.id === conversationId);
    if (!row) return null;

    row.lastMessageAt = patch.lastMessageAt;
    row.lastMessagePreview = patch.lastMessagePreview;
    row.updatedAt = new Date().toISOString();
    return { ...row };
  }

  /**
   * convo-count — counts por status del contacto, agrupados por E164 canónico.
   * MUST mirror `PrismaConversationRepository.countByContactPhoneE164` (groupBy
   * por status): buckets con la MISMA semántica LS-1 que el filtro de `list`
   * (`resolved` = match exacto; `open` = todo lo demás, incl. pending/snoozed).
   */
  async countByContactPhoneE164(phoneE164: string): Promise<ConversationStatusCounts> {
    const rows = this.rows.filter((r) => r.contactPhoneE164 === phoneE164);
    const resolved = rows.filter((r) => r.status === 'resolved').length;
    return { total: rows.length, open: rows.length - resolved, resolved };
  }

  /**
   * inbox-views (Ola 1, COUNT-1) — sync INTERNO del cache desnormalizado
   * `lastPublicMessageDirection`, llamado EXCLUSIVAMENTE por
   * `InMemoryChatMessageRepository` tras cada write de mensaje (espejo del
   * recompute que `PrismaChatMessageRepository` hace contra la tabla). NUNCA lo
   * llama un use case — no es parte del port, es el lazo adapter↔adapter que
   * simula el hecho de que en Postgres ambos "repos" comparten la misma DB.
   */
  syncLastPublicMessageDirection(conversationId: string, direction: 'inbound' | 'outbound' | null): void {
    const row = this.rows.find((r) => r.id === conversationId);
    if (!row) return;
    row.lastPublicMessageDirection = direction;
  }

  /**
   * inbox-views (Ola 1, COUNT-2) — ÚNICA fuente de verdad de los filtros del
   * listado, compartida por `list` y `count` (espejo de `buildConversationWhere`
   * en PrismaConversationRepository — MUST no divergir). Los counts por vista
   * usan EXACTAMENTE esta semántica, así el número del badge siempre coincide
   * con lo que el listado devuelve.
   */
  private applyFilters(query: ConversationListQuery): ConversationRecord[] {
    // F1.5-C2 — assignment filter (Mine/Unassigned/All). `assigneeId` truthy wins
    // over `unassigned` if both were somehow set (same precedence documented on
    // the port), mirroring PrismaConversationRepository's `where` construction.
    let filtered = this.rows;
    if (query.assigneeId) {
      filtered = filtered.filter((r) => r.assigneeId === query.assigneeId);
    } else if (query.unassigned) {
      filtered = filtered.filter((r) => r.assigneeId === null);
    }
    // messaging-bulk-inbox (F1, etiqueta #1) — filtro por campaña (JOIN
    // Conversation×CampaignRecipient). Combinable con el filtro de asignación.
    if (query.campaignId) {
      filtered = filtered.filter((r) => r.campaigns.some((c) => c.id === query.campaignId));
    }
    // inbox-views (VIEW-1) — bucket "Sin atender": NO-resuelta + último mensaje
    // público inbound. GANA sobre `status` (lleva su propio filtro de ciclo de
    // vida — ver JSDoc del port). inbox-resolve (LS-1) — filtro de ciclo de vida
    // con semántica de BUCKET (ver `ConversationListQuery.status`). MUST mirror
    // `PrismaConversationRepository`'s `where` construction exactly.
    if (query.unattended) {
      filtered = filtered.filter((r) => r.status !== 'resolved' && r.lastPublicMessageDirection === 'inbound');
    } else if (query.status === 'open') {
      filtered = filtered.filter((r) => r.status !== 'resolved');
    } else if (query.status === 'resolved') {
      filtered = filtered.filter((r) => r.status === 'resolved');
    }
    return filtered;
  }

  /**
   * inbox-views (Ola 1, COUNT-2) — count con la MISMA semántica de filtros que
   * `list` (comparte `applyFilters`, una sola fuente de verdad). Anti-N+1: jamás
   * pagina ni trae filas para contar.
   */
  async count(query: ConversationListQuery): Promise<number> {
    return this.applyFilters(query).length;
  }

  async list(query: ConversationListQuery): Promise<PaginatedResult<ConversationRecord>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;

    const filtered = this.applyFilters(query);

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
