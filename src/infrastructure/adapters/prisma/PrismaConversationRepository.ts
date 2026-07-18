import {
  ConversationRepository,
  ConversationRecord,
  ConversationListQuery,
  ConversationCampaignRef,
  ConversationLabelRef,
  ConversationStatusCounts,
  UpsertConversationInput,
  UpsertBulkConversationInput,
  UpdateConversationLocalFieldsInput,
  BumpLastMessageInput,
} from '@domain/ports/ConversationRepository';
import { PaginatedResult } from '@application/dto/pagination';
import { toWhatsAppE164 } from '@application/use-cases/messaging/toWhatsAppE164';
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
  // messaging-bulk-inbox (F1, etiqueta #1) — JOIN a las campañas via el lazo
  // CampaignRecipient (dedup por campaña en toDomain). Evita N+1 (un solo include).
  campaignRecipients: { select: { campaign: { select: { id: true, name: true } } } },
  // conversation-labels (Ola 5) — JOIN a las labels via la join ConversationLabelAssignment.
  // Un solo include, anti-N+1 (jamás una query por fila).
  labelAssignments: { select: { label: { select: { id: true, name: true, color: true } } } },
} as const;

/** messaging-bulk-inbox (F1) — dedup de las campañas JOIN-derived (un recipient por campaña). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCampaigns(recipients: any[] | undefined): ConversationCampaignRef[] {
  if (!recipients) return [];
  const seen = new Map<string, ConversationCampaignRef>();
  for (const r of recipients) {
    const c = r?.campaign;
    if (c && !seen.has(c.id)) seen.set(c.id, { id: c.id, name: c.name });
  }
  return Array.from(seen.values());
}

/** conversation-labels (Ola 5) — proyecta las labels JOIN-derived (id/name/color). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toLabels(assignments: any[] | undefined): ConversationLabelRef[] {
  if (!assignments) return [];
  const out: ConversationLabelRef[] = [];
  for (const a of assignments) {
    const l = a?.label;
    if (l) out.push({ id: l.id, name: l.name, color: l.color });
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDomain(row: any): ConversationRecord {
  return {
    id: row.id,
    chatwootConversationId: row.chatwootConversationId ?? null,
    origin: row.origin ?? 'chatwoot',
    contactName: row.contactName ?? null,
    contactPhone: row.contactPhone ?? null,
    contactPhoneE164: row.contactPhoneE164 ?? null,
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
    campaigns: toCampaigns(row.campaignRecipients),
    // conversation-labels (Ola 5) — JOIN-derived de ConversationLabelAssignment.
    labels: toLabels(row.labelAssignments),
    // inbox-views (VIEW-1) — cache desnormalizado mantenido por
    // PrismaChatMessageRepository (choke point de escritura de mensajes).
    lastPublicMessageDirection: (row.lastPublicMessageDirection as 'inbound' | 'outbound' | null) ?? null,
    // messaging-inbox-notes (edit/delete, COUNT) — desnormalizado, mismo choke point.
    internalNoteCount: row.internalNoteCount ?? 0,
    // conversation-events (Ola 2) — timestamps derivados del ciclo de resolución.
    resolvedAt: toIso(row.resolvedAt),
    firstResolvedAt: toIso(row.firstResolvedAt),
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

/**
 * inbox-views (Ola 1, COUNT-2) — ÚNICA fuente de verdad del `where` del listado,
 * compartida por `list` y `count` (espejo de `applyFilters` en
 * InMemoryConversationRepository — MUST no divergir). Los counts por vista usan
 * EXACTAMENTE esta semántica, así el número del badge siempre coincide con el
 * total que el listado devuelve.
 */
function buildConversationWhere(query: ConversationListQuery): Record<string, unknown> {
  // F1.5-C2 — assignment filter (Mine/Unassigned/All). `assigneeId` truthy wins
  // over `unassigned` (same precedence as InMemoryConversationRepository).
  const where: Record<string, unknown> = {};
  if (query.assigneeId) {
    where['assigneeId'] = query.assigneeId;
  } else if (query.unassigned) {
    where['assigneeId'] = null;
  }
  // messaging-bulk-inbox (F1, etiqueta #1) — filtro por campaña vía el lazo
  // CampaignRecipient (JOIN Conversation×CampaignRecipient). Combinable con asignación.
  if (query.campaignId) {
    where['campaignRecipients'] = { some: { campaignId: query.campaignId } };
  }
  // conversation-labels (Ola 5) — filtro por label asignada vía la join
  // ConversationLabelAssignment. Combinable en AND. MUST mirror
  // `InMemoryConversationRepository.applyFilters`.
  if (query.labelId) {
    where['labelAssignments'] = { some: { labelId: query.labelId } };
  }
  // note-mentions (Ola 6b) — vista "Menciones": la conversación tiene alguna mención NO leída
  // del usuario actual (subquery relacional sobre el índice (mentionedUserId, readAt)). AND
  // independiente, sin acoplarse a `status`. MUST mirror `InMemoryConversationRepository.applyFilters`.
  if (query.mentionedUserId) {
    where['mentions'] = { some: { mentionedUserId: query.mentionedUserId, readAt: null } };
  }
  // inbox-views (VIEW-1) — bucket "Sin atender": NO-resuelta + último mensaje
  // público inbound. GANA sobre `status` (lleva su propio filtro de ciclo de vida,
  // ver JSDoc del port). inbox-resolve (LS-1) — filtro de ciclo de vida con
  // semántica de BUCKET. MUST mirror `InMemoryConversationRepository.applyFilters`.
  if (query.unattended) {
    where['status'] = { not: 'resolved' };
    where['lastPublicMessageDirection'] = 'inbound';
  } else if (query.status === 'open') {
    where['status'] = { not: 'resolved' };
  } else if (query.status === 'resolved') {
    where['status'] = 'resolved';
  } else if (query.status === 'pending') {
    // conversation-events (Ola 2) — match EXACTO (subconjunto de 'open'), para currentPending.
    where['status'] = 'pending';
  }
  return where;
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
  if (input.contactPhone !== undefined) {
    data['contactPhone'] = input.contactPhone;
    // messaging-bulk-inbox (🟠 HIGH) — refresca el E164 canónico así una conversación
    // Chatwoot creada/actualizada post-migración es matcheable por el bulk (no queda NULL).
    data['contactPhoneE164'] = toWhatsAppE164(input.contactPhone);
  }
  if (input.status !== undefined) data['status'] = input.status;
  if (input.canReply !== undefined) data['canReply'] = input.canReply;
  if (input.lastMessageAt !== undefined) {
    data['lastMessageAt'] = input.lastMessageAt === null ? null : new Date(input.lastMessageAt);
  }
  if (input.lastMessagePreview !== undefined) data['lastMessagePreview'] = input.lastMessagePreview;
  // conversation-events (Ola 2) — resolvedAt/firstResolvedAt escritos atómicos con el status.
  if (input.resolvedAt !== undefined) {
    data['resolvedAt'] = input.resolvedAt === null ? null : new Date(input.resolvedAt);
  }
  if (input.firstResolvedAt !== undefined) {
    data['firstResolvedAt'] = input.firstResolvedAt === null ? null : new Date(input.firstResolvedAt);
  }
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
        // messaging-bulk-inbox (🟠 HIGH) — E164 canónico también en el path de Chatwoot.
        contactPhoneE164: toWhatsAppE164(input.contactPhone ?? null),
        status: input.status ?? 'open',
        canReply: input.canReply ?? false,
        lastMessageAt: input.lastMessageAt ? new Date(input.lastMessageAt) : null,
        lastMessagePreview: input.lastMessagePreview ?? null,
        // conversation-events (Ola 2) — normalmente null en la creación (una conversación
        // nace 'open'); se pasan por completitud si el input los trajera.
        resolvedAt: input.resolvedAt ? new Date(input.resolvedAt) : null,
        firstResolvedAt: input.firstResolvedAt ? new Date(input.firstResolvedAt) : null,
        // F1.5-C2 — assigneeId/areaId deliberately absent: schema default (null),
        // never set from Chatwoot-sourced input.
      },
      update: updateData(input),
      include: CONVERSATION_INCLUDE,
    });
    return toDomain(row);
  }

  /**
   * messaging-bulk-inbox (F1, PROYECCIÓN) — write-path BULK por E164 canónico
   * (SEPARADO de `upsertByChatwootId`). Appendea a la conversación MÁS RECIENTE con
   * ese `contactPhoneE164` (cualquier origen) o crea una `origin:'bulk'`.
   * NUNCA toca assigneeId/areaId (LOCAL-only) — no las incluye en el `data`.
   */
  async upsertBulkByPhone(
    phoneE164: string,
    input: UpsertBulkConversationInput,
  ): Promise<ConversationRecord> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = await (prisma as any).conversation.findFirst({
      where: { contactPhoneE164: phoneE164 },
      orderBy: { createdAt: 'desc' },
      include: CONVERSATION_INCLUDE,
    });

    if (existing) {
      const data: Record<string, unknown> = {};
      if (existing.contactName == null && input.contactName != null) data['contactName'] = input.contactName;
      if (existing.contactPhone == null && input.contactPhone != null) data['contactPhone'] = input.contactPhone;
      if (input.lastMessageAt !== undefined) {
        data['lastMessageAt'] = input.lastMessageAt === null ? null : new Date(input.lastMessageAt);
      }
      if (input.lastMessagePreview !== undefined) data['lastMessagePreview'] = input.lastMessagePreview;
      if (Object.keys(data).length === 0) return toDomain(existing);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updated = await (prisma as any).conversation.update({
        where: { id: existing.id },
        data,
        include: CONVERSATION_INCLUDE,
      });
      return toDomain(updated);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).conversation.create({
      data: {
        chatwootConversationId: null,
        origin: 'bulk',
        contactName: input.contactName ?? null,
        contactPhone: input.contactPhone ?? null,
        contactPhoneE164: phoneE164,
        lastMessageAt: input.lastMessageAt ? new Date(input.lastMessageAt) : null,
        lastMessagePreview: input.lastMessagePreview ?? null,
      },
      include: CONVERSATION_INCLUDE,
    });
    return toDomain(row);
  }

  /**
   * messaging-bulk-inbox (F1, FASE 2 — reconciliación AISLADA) — adopta una
   * conversación `origin:'bulk'` (chatwootConversationId=null) con el mismo
   * `contactPhoneE164` (E164 canónico), seteándole `chatwootConversationId` in-place
   * (CONSERVA el id). No-op si el chatwootConversationId ya está tomado (conversación
   * Chatwoot existente — jamás tocarla) o si no hay bulk pendiente.
   */
  async adoptBulkConversation(
    phoneE164: string,
    chatwootConversationId: number,
  ): Promise<ConversationRecord | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taken = await (prisma as any).conversation.findUnique({ where: { chatwootConversationId } });
    if (taken) return null; // ya existe una conversación con ese id de Chatwoot → no-op

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target = await (prisma as any).conversation.findFirst({
      where: { origin: 'bulk', chatwootConversationId: null, contactPhoneE164: phoneE164 },
      orderBy: { createdAt: 'desc' },
    });
    if (!target) return null;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).conversation.update({
        where: { id: target.id },
        data: { chatwootConversationId },
        include: CONVERSATION_INCLUDE,
      });
      return toDomain(row);
    } catch (err) {
      // P2002 — carrera: otro alguien tomó ese chatwootConversationId entre el check
      // y el update → no-op seguro (jamás pisar la conversación Chatwoot que ganó).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((err as any)?.code === 'P2002') return null;
      throw err;
    }
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

  /**
   * conversation-labels (Ola 5) — REEMPLAZA el set de labels de la conversación en
   * UNA transacción: borra todas las asignaciones actuales y crea las nuevas
   * (`skipDuplicates` por si el caller repite ids, aunque el use case ya deduplica).
   * LOCAL-only. Devuelve la conversación con el include estándar (labels frescas), o
   * `null` si la conversación no existe (P2025/P2003 en el createMany por FK). El use
   * case (`SetConversationLabels`) ya valida existencia de conversación + labels antes.
   */
  async setLabels(conversationId: string, labelIds: string[]): Promise<ConversationRecord | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).$transaction(async (tx: any) => {
        await tx.conversationLabelAssignment.deleteMany({ where: { conversationId } });
        if (labelIds.length > 0) {
          await tx.conversationLabelAssignment.createMany({
            data: labelIds.map((labelId) => ({ conversationId, labelId })),
            skipDuplicates: true,
          });
        }
      });
    } catch (err) {
      // P2025 (record not found) / P2003 (FK violation: conversation/label gone) →
      // "return null on miss", misma convención que updateLocalFields.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const code = (err as any)?.code;
      if (code === 'P2025' || code === 'P2003') return null;
      throw err;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).conversation.findUnique({
      where: { id: conversationId },
      include: CONVERSATION_INCLUDE,
    });
    return row ? toDomain(row) : null;
  }

  /**
   * inbox-template-send (PORT-2) — bump del preview tras un envío one-off de
   * template. Escribe EXCLUSIVAMENTE lastMessageAt/lastMessagePreview — nunca
   * `canReply`/`status`/`assigneeId`/`areaId` (design D2). Cross-ref: MISMA
   * semántica que `InMemoryConversationRepository.bumpLastMessage`.
   */
  async bumpLastMessage(
    conversationId: string,
    patch: BumpLastMessageInput,
  ): Promise<ConversationRecord | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: new Date(patch.lastMessageAt),
          lastMessagePreview: patch.lastMessagePreview,
        },
        include: CONVERSATION_INCLUDE,
      });
      return toDomain(row);
    } catch (err) {
      // P2025 = record not found — same "return null on miss" convention as updateLocalFields.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((err as any)?.code === 'P2025') return null;
      throw err;
    }
  }

  /**
   * convo-count — anti-N+1: UNA agregación `groupBy(status)` sobre el índice
   * `@@index([contactPhoneE164])`, jamás trae filas. Buckets con la MISMA
   * semántica LS-1 que el filtro de `list` (`resolved` exacto; `open` = resto,
   * incl. pending/snoozed passthrough) — MUST mirror
   * `InMemoryConversationRepository.countByContactPhoneE164`.
   */
  async countByContactPhoneE164(phoneE164: string): Promise<ConversationStatusCounts> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const groups: Array<{ status: string; _count: { _all: number } }> = await (prisma as any).conversation.groupBy({
      by: ['status'],
      where: { contactPhoneE164: phoneE164 },
      _count: { _all: true },
    });
    let total = 0;
    let resolved = 0;
    for (const g of groups) {
      total += g._count._all;
      if (g.status === 'resolved') resolved += g._count._all;
    }
    return { total, open: total - resolved, resolved };
  }

  /**
   * previous-conversations (Ola 6a) — otras conversaciones del contacto por E164
   * canónico (índice `@@index([contactPhoneE164])`), excluyendo la actual, ordenadas
   * por lastMessageAt DESC (nulls last, id ASC tiebreaker — MISMO orderBy que `list`)
   * y truncadas a `limit`. Anti-N+1: UN solo `findMany` con `CONVERSATION_INCLUDE`
   * (labels/assignee en el mismo roundtrip, jamás una query por fila). MUST mirror
   * `InMemoryConversationRepository.listByContactPhoneE164`.
   */
  async listByContactPhoneE164(
    phoneE164: string,
    excludeConversationId: string,
    limit: number,
  ): Promise<ConversationRecord[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (prisma as any).conversation.findMany({
      where: { contactPhoneE164: phoneE164, id: { not: excludeConversationId } },
      include: CONVERSATION_INCLUDE,
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      take: limit,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => toDomain(r));
  }

  /**
   * inbox-views (Ola 1, COUNT-2) — count con el MISMO where que `list` (comparte
   * `buildConversationWhere`, una sola fuente de verdad). Anti-N+1: un único
   * `COUNT` agregado, jamás trae filas.
   */
  async count(query: ConversationListQuery): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).conversation.count({ where: buildConversationWhere(query) });
  }

  /**
   * conversation-events (Ola 2, reports/overview) — `createdAt` en `[fromIso, toIso)`.
   * Anti-N+1: un solo `COUNT`. MUST mirror `InMemoryConversationRepository.countCreatedBetween`.
   */
  async countCreatedBetween(fromIso: string, toIso: string): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).conversation.count({
      where: { createdAt: { gte: new Date(fromIso), lt: new Date(toIso) } },
    });
  }

  async list(query: ConversationListQuery): Promise<PaginatedResult<ConversationRecord>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;

    const where = buildConversationWhere(query);

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
