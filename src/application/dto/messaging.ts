import type { ConversationRecord } from '@domain/ports/ConversationRepository';
import type { ChatMessageRecord } from '@domain/ports/ChatMessageRepository';
import type { ChatMessageAttachmentRecord } from '@domain/ports/ChatMessageAttachmentRepository';
import type { CustomerStatus } from '@domain/entities/customer';

/**
 * messaging-inbox (F1, design §5) — DTOs for the inbox. Never expose the mirror's
 * Prisma-shaped records (`ConversationRecord`/`ChatMessageRecord`) directly through
 * a route or use-case return value — always go through the mappers below.
 */

// ─── Conversation list item ──────────────────────────────────────────────────
// Note the field RENAME vs the mirror row: `ConversationRecord.lastMessagePreview`
// → `preview` on the wire (design §5) — deliberate, not a typo.

// F1.5-C2 (asignación) — nested shape, no un flat `assigneeId/assigneeName` como
// `Ticket` (design del contrato de esta fase): el FE consume `assignee`/`area`
// como objeto único o `null`, nunca dos campos sueltos a reconciliar.
export interface ConversationAssigneeDto {
  id: string;
  name: string;
}

export interface ConversationAreaDto {
  id: string;
  name: string;
  color: string;
}

/** messaging-bulk-inbox (F1, etiqueta #1) — campaña asociada a la conversación. */
export interface ConversationCampaignDto {
  id: string;
  name: string;
}

/** conversation-labels (Ola 5) — etiqueta de color asignada a la conversación. */
export interface ConversationLabelDto {
  id: string;
  name: string;
  color: string;
}

export interface ConversationListItemDto {
  id: string;
  contactName: string | null;
  contactPhone: string | null;
  lastMessageAt: string | null;
  preview: string | null;
  status: string;
  /** F1.5-C2 — LOCAL-only (Chatwoot never sees this). `null` = unassigned. */
  assignee: ConversationAssigneeDto | null;
  /** F1.5-C2 — LOCAL-only (Chatwoot never sees this). `null` = no area set. */
  area: ConversationAreaDto | null;
  /**
   * messaging-bulk-inbox (F1, etiqueta #1) — campañas de esta conversación
   * (JOIN-derived del lazo CampaignRecipient). `[]` cuando no participa en ninguna.
   */
  campaigns: ConversationCampaignDto[];
  /**
   * conversation-labels (Ola 5) — etiquetas de color de la conversación (id/name/color),
   * JOIN-derived del record. `[]` cuando no tiene ninguna. Alimenta los chips de la
   * fila del inbox (mismo molde que `campaigns` — flat en el record, proyectado acá).
   */
  labels: ConversationLabelDto[];
  /**
   * messaging-inbox-notes (edit/delete, COUNT) — nº de notas internas VIVAS de la
   * conversación (isPrivate=true AND deletedAt IS NULL). Alimenta el indicador 📝+N
   * de la lista del inbox. Desnormalizado (Conversation.internalNoteCount), O(1).
   */
  internalNoteCount: number;
}

// ─── Previous conversations (previous-conversations, Ola 6a) ──────────────────
// DTO LIVIANO para la lista "Conversaciones previas" del panel de contexto del
// inbox (equivalente a Chatwoot's "Previous Conversations"). Es un SUBCONJUNTO
// deliberado de `ConversationListItemDto` — solo lo útil para una fila COMPACTA —,
// NUNCA el item pesado del inbox (sin `contactName`/`contactPhone`/`assignee`
// anidado/`area`/`campaigns`/`internalNoteCount`). Incluye `labels` + `status`
// (valiosos para pintar el chip/estado de cada previa) y `assigneeName` PLANO (no
// el objeto `assignee` del item pesado — acá alcanza el nombre para una fila).
export interface PreviousConversationDto {
  id: string;
  status: string;
  lastMessageAt: string | null;
  /** El preview del último mensaje. Nombre `lastMessagePreview` (NO el rename
   * `preview` del item pesado) — este DTO no reusa ese wire. */
  lastMessagePreview: string | null;
  /** Nombre del agente asignado (plano, JOIN-derived), o `null` si sin asignar. */
  assigneeName: string | null;
  /**
   * Derivado de `ConversationRecord.lastPublicMessageDirection === 'inbound'`: el
   * cliente habló último y ningún agente respondió por WhatsApp (la MISMA señal
   * "Sin atender"/unattended del inbox). Es el proxy HONESTO de "sin leer" que el
   * mirror puede ofrecer — NO existe estado de lectura por-agente en el modelo.
   */
  unread: boolean;
  /** Etiquetas de color de la previa (JOIN-derived), `[]` cuando no tiene. */
  labels: ConversationLabelDto[];
}

// ─── Assignable users (F1.5-C2, dropdown) ────────────────────────────────────
// Deliberately minimal — NEVER passwordHash/email/login/any auth-internal field.

export interface AssignableUserDto {
  id: string;
  name: string;
}

// ─── Client context (CTX-1) ──────────────────────────────────────────────────

export interface ClientContextClientDto {
  id: string;
  name: string;
  status: string;
}

export interface ClientContextDto {
  status: 'matched' | 'unknown' | 'ambiguous';
  clients: ClientContextClientDto[];
}

// ─── Conversation detail (GetConversation, fetch-on-open) ───────────────────

export interface ConversationDetailDto extends ConversationListItemDto {
  canReply: boolean;
  clientContext: ClientContextDto;
}

// ─── Inbox client context (F1.5, RICH-1..6) — rich, on-demand aggregate ─────
// Never expose `PppoeService.password` nor a raw Prisma entity anywhere in this
// tree (RICH-3 #16). Every section is truncated to a fixed limit — see design.

export interface InboxBalanceDto {
  due: number | null;
  currency: string | null;
  /** `due != null && due > 0` */
  isDebtor: boolean;
  /** TTL 60min over `lastRefreshedAt`, computed via `isBalanceOlderThanTtl` (RICH-4). */
  stale: boolean;
  lastRefreshedAt: string | null;
}

export interface InboxInvoiceSummaryDto {
  id: string;
  number: string;
  dueDate: string;
  amount: number;
  status: 'pagada' | 'pendiente' | 'vencida';
  balance: number | null;
}

export interface InboxContractSummaryDto {
  id: string;
  plan: string;
  status: string;
  technology: string | null;
  address: string | null;
  /** `pppoeDisplayStatus`, mirror-only (no RADIUS). `null` when the contract has
   * no PPPoE service, or when the lookup for it failed (RICH-2, isolated failure). */
  serviceStatus: 'active' | 'reduced' | 'blocked' | 'baja' | 'inactive' | null;
}

export interface InboxTicketSummaryDto {
  id: string;
  sequenceNumber: number;
  subject: string;
  status: string;
  priority: string;
}

export interface InboxTaskSummaryDto {
  id: string;
  sequenceNumber: number;
  title: string;
  status: string;
}

export interface InboxLogSummaryDto {
  id: string;
  timestamp: string;
  eventType: string;
  description: string;
}

export interface InboxClientSummaryDto {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** fix-be #3 — typed against the domain union (was widened to `string`, losing
   * type-safety at every call site). */
  status: CustomerStatus; // active|late|blocked|inactive|baja
  /** The FE builds the link to the existing ficha from this id (same as `id`). */
  fichaClientId: string;
  balance: InboxBalanceDto;
  /** The single most recent invoice, or null when the client has none. */
  lastInvoice: InboxInvoiceSummaryDto | null;
  /** dueDate of the next PENDING invoice, or null. */
  nextDueDate: string | null;
  /** No fixed limit — cardinality is small (1-2 contracts per client). */
  contracts: InboxContractSummaryDto[];
  /** Total open tickets, via `TicketRepository.countOpenByClientIds` — NEVER the
   * (truncated) length of `recentTickets` (RICH-3, scenario "más de 3 abiertos"). */
  openTicketsCount: number;
  /** Max 3, open only. */
  recentTickets: InboxTicketSummaryDto[];
  /** states-be (F1.5 spec #2) — total closed tickets, via
   * `TicketRepository.countClosedByClientIds` — NEVER the truncated length of
   * `recentClosedTickets`. "Closed" = `Ticket.resolvedAt != null` (archivedAt: null). */
  closedTicketsCount: number;
  /** states-be (F1.5 spec #2) — max 2, closed only (resolvedAt != null). */
  recentClosedTickets: InboxTicketSummaryDto[];
  /** states-be (F1.5 spec #2) — total OPEN tasks (`generalStatus === 'open'`).
   * Computed from the full (unfiltered, unpaginated) `ListTasks` result — never
   * truncated, since `ListTasks` has no server-side limit (pre-existing debt,
   * tracked separately; NOT worsened here). */
  openTasksCount: number;
  /** Max 3, OPEN only (`generalStatus === 'open'`). */
  recentTasks: InboxTaskSummaryDto[];
  /** states-be (F1.5 spec #2) — total closed+dismissed tasks
   * (`generalStatus !== 'open'`) — NEVER the legacy `isClosed` flag (misleading:
   * a `dismissed` task has `isClosed === false`). */
  closedTasksCount: number;
  /** states-be (F1.5 spec #2) — max 2, closed+dismissed (`generalStatus !== 'open'`). */
  recentClosedTasks: InboxTaskSummaryDto[];
  /** Max 5, first page. */
  recentLogs: InboxLogSummaryDto[];
}

/**
 * convo-count — contador de interacciones del contacto ("cuántas veces abrió una
 * conversación"). 1 interacción = 1 fila `Conversation` del contacto: el mirror
 * tiene UNA fila por conversación de Chatwoot que se REABRE in-place SIN
 * historial de transiciones (no hay resolvedAt ni tabla de eventos —
 * `conversation_status_changed` solo se dedupea en WebhookDelivery), así que el
 * COUNT de filas es el único contador que no miente. Buckets con la MISMA
 * semántica LS-1 del filtro del inbox: `open` = `status != 'resolved'` (incluye
 * `pending`/`snoozed` passthrough), `resolved` = exacto. Invariante:
 * `total === open + resolved`.
 */
export interface InboxConversationCountsDto {
  total: number;
  open: number;
  resolved: number;
}

/**
 * inbox-views (Ola 1, COUNT-1) — contadores por VISTA del inbox (badges de la
 * sidebar), shape EXACTO del wire de `GET /api/messaging/conversations/counts`.
 * `mine`/`unattended`/`all`/`unassigned` cuentan SOLO NO-resueltas
 * (`status != 'resolved'`, bucket LS-1); `resolved` va aparte (match exacto).
 * NO confundir con `InboxConversationCountsDto` (convo-count: interacciones de
 * UN contacto por teléfono, panel de contexto) — este es el agregado GLOBAL del
 * inbox por vista.
 */
export interface InboxViewCountsDto {
  /** No-resueltas asignadas al user autenticado. */
  mine: number;
  /** No-resueltas cuyo último mensaje público es inbound (Sin atender). */
  unattended: number;
  /** Todas las no-resueltas. */
  all: number;
  /** No-resueltas sin assignee. */
  unassigned: number;
  /** status === 'resolved' (bucket aparte, no solapa con los otros). */
  resolved: number;
}

export interface InboxClientContextDto {
  status: 'matched' | 'ambiguous' | 'unknown';
  /** Only present for `ambiguous` WITHOUT a chosen `clientId` — never carries
   * aggregated data for any candidate (RICH-1, no data leak before the agent picks). */
  candidates?: ClientContextClientDto[];
  /** `matched`, or the candidate already chosen via `?clientId=`. */
  client?: InboxClientSummaryDto;
  /**
   * convo-count — SIEMPRE presente (matched/ambiguous/unknown): la asociación
   * conversación↔cliente de este modelo ES el teléfono (Conversation no tiene
   * clientId; el match del panel se deriva del contactPhone), así que el contador
   * se agrupa por `contactPhoneE164` canónico — computable aunque no haya cliente
   * matcheado. En `ambiguous` no filtra datos de ningún candidato (RICH-1): son
   * counts del mirror de mensajería que el agente ya ve en el inbox. Fallback sin
   * clave E164 reconstruible: self-count (solo esta conversación). Degrada a
   * ceros si el count falla (misma disciplina RICH-2 del resto del panel).
   */
  conversations: InboxConversationCountsDto;
}

// ─── Chat message ─────────────────────────────────────────────────────────────

export interface ChatMessageDto {
  id: string;
  direction: 'inbound' | 'outbound';
  content: string;
  senderName: string | null;
  sentAt: string;
  /** messaging-inbox-notes (F1.5 fase D, NOTE-5) — rename de wire vs el dominio
   * (`ChatMessageRecord.isPrivate`), mismo nombre que Chatwoot usa en su propio wire. */
  private: boolean;
  /**
   * messaging-inbox-notes (edit/delete) — usuario RBAC autor de la nota interna.
   * `null` para mensajes públicos y notas históricas (sólo un supervisor puede tocarlas).
   */
  authorId: string | null;
  /** messaging-inbox-notes (edit/delete) — `editedAt != null` (la nota fue editada). */
  edited: boolean;
  /**
   * messaging-inbox-notes (edit/delete) — `deletedAt != null` (soft-deleted). Cuando
   * es `true`, `content` viaja VACÍO (nunca se filtra el texto original): el FE renderiza
   * el tombstone ("nota eliminada") a partir de este flag. La fila NO se filtra del hilo.
   */
  deleted: boolean;
  /**
   * messaging-inbox-notes (edit/delete) — computado contra el USUARIO ACTUAL: `true` si
   * la nota es interna, NO está borrada, y el actor es el autor O un supervisor
   * (`messaging:manage`). El FE muestra los controles editar/eliminar sólo si es `true`.
   * `canDelete` usa la MISMA autorización que `canEdit`.
   */
  canEdit: boolean;
  canDelete: boolean;
  attachments: ChatMessageAttachmentDto[];
}

/**
 * messaging-inbox-notes (edit/delete) — contexto del actor para computar
 * `canEdit`/`canDelete` en el mapper. `userId` = req.user.id autenticado;
 * `canManage` = tiene `messaging:manage` (supervisor). Ausente → sin permisos (false).
 */
export interface ChatMessageActor {
  userId?: string | null;
  canManage?: boolean;
}

/**
 * messaging-inbox-notes (edit/delete) — autorización canónica de mutación de una nota
 * interna, ÚNICA fuente de verdad compartida por el mapper del DTO (canEdit/canDelete) y
 * los use cases (EditInternalNote/DeleteInternalNote): sólo el autor O un supervisor
 * (`canManage`); si `authorId` es NULL, sólo el supervisor. NO chequea isPrivate/deleted
 * (eso lo hacen los guards del use case y el mapper por separado).
 */
export function actorMayMutateNote(authorId: string | null, actor?: ChatMessageActor): boolean {
  if (!actor) return false;
  if (actor.canManage === true) return true;
  return authorId !== null && !!actor.userId && authorId === actor.userId;
}

// ─── Chat message attachment (messaging-inbox-v2-media, F1.5 fase A, Tanda 1 · MEDIA-4) ─
// NEVER expose `sourceUrl`/`thumbSourceUrl`/`storageKey`/`thumbStorageKey`/`lastError`/
// `downloadAttempts` — `url`/`thumbUrl` are BE-proxy routes, never a Chatwoot/MinIO URL.

export interface ChatMessageAttachmentDto {
  id: string;
  fileType: 'image' | 'audio' | 'video' | 'file';
  contentType: string;
  filename: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  status: 'pending' | 'downloaded' | 'failed';
  url: string;
  thumbUrl: string | null;
}

/** Base de los endpoints de file (montado en /api/messaging — B5.4). */
const CHAT_ATTACHMENTS_FILE_BASE = '/api/messaging/attachments';

export function toChatMessageAttachmentDto(a: ChatMessageAttachmentRecord): ChatMessageAttachmentDto {
  return {
    id: a.id,
    fileType: a.fileType as ChatMessageAttachmentDto['fileType'],
    contentType: a.contentType,
    filename: a.filename,
    fileSize: a.sizeBytes,
    width: a.width,
    height: a.height,
    status: a.status,
    url: `${CHAT_ATTACHMENTS_FILE_BASE}/${a.id}/file`,
    // thumb falls back to the original at serve-time (GetChatAttachmentFile) when
    // there's no thumbStorageKey — here we simply omit the query param (null) so the
    // FE knows not to request a thumb variant that doesn't exist.
    thumbUrl: a.thumbStorageKey ? `${CHAT_ATTACHMENTS_FILE_BASE}/${a.id}/file?variant=thumb` : null,
  };
}

// ─── Mappers (pure functions of the mirror record) ──────────────────────────

export function toConversationListItemDto(record: ConversationRecord): ConversationListItemDto {
  return {
    id: record.id,
    contactName: record.contactName,
    contactPhone: record.contactPhone,
    lastMessageAt: record.lastMessageAt,
    preview: record.lastMessagePreview,
    status: record.status,
    // F1.5-C2 — built from the JOIN-derived flat fields (assigneeName/areaName/
    // areaColor), same "flat on the record, nested on the wire" split as the
    // rest of this mapper (never leaks the raw ConversationRecord shape).
    assignee: record.assigneeId ? { id: record.assigneeId, name: record.assigneeName ?? '' } : null,
    area: record.areaId
      ? { id: record.areaId, name: record.areaName ?? '', color: record.areaColor ?? '#6366f1' }
      : null,
    // messaging-bulk-inbox (F1, etiqueta #1) — JOIN-derived en el record; el mapper
    // solo proyecta (nunca leakea el shape crudo del ConversationRecord).
    campaigns: record.campaigns.map((c) => ({ id: c.id, name: c.name })),
    // conversation-labels (Ola 5) — JOIN-derived en el record; el mapper solo proyecta.
    labels: record.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    // messaging-inbox-notes (edit/delete) — desnormalizado en el record.
    internalNoteCount: record.internalNoteCount,
  };
}

/**
 * previous-conversations (Ola 6a) — proyecta el DTO LIVIANO de una conversación
 * previa (ver `PreviousConversationDto`). Función pura del record; nunca leakea el
 * shape crudo del mirror. `unread` deriva de `lastPublicMessageDirection === 'inbound'`.
 */
export function toPreviousConversationDto(record: ConversationRecord): PreviousConversationDto {
  return {
    id: record.id,
    status: record.status,
    lastMessageAt: record.lastMessageAt,
    lastMessagePreview: record.lastMessagePreview,
    assigneeName: record.assigneeName,
    unread: record.lastPublicMessageDirection === 'inbound',
    labels: record.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
  };
}

export function toChatMessageDto(
  record: ChatMessageRecord,
  attachments: ChatMessageAttachmentRecord[] = [],
  /**
   * messaging-inbox-notes (edit/delete) — actor actual para computar canEdit/canDelete.
   * Ausente → ambos false (mismo DTO, sin controles de edición — p.ej. un listado sin
   * sesión no debería ocurrir, pero degrada seguro).
   */
  actor?: ChatMessageActor,
): ChatMessageDto {
  const deleted = record.deletedAt !== null;
  const mayMutate = record.isPrivate && !deleted && actorMayMutateNote(record.authorId, actor);
  return {
    id: record.id,
    direction: record.direction,
    // messaging-inbox-notes (edit/delete) — una nota borrada NUNCA expone su texto
    // original: viaja vacío y el FE pinta el tombstone desde `deleted`.
    content: deleted ? '' : record.content,
    senderName: record.senderName,
    sentAt: record.chatwootCreatedAt,
    private: record.isPrivate,
    authorId: record.authorId,
    edited: record.editedAt !== null,
    deleted,
    canEdit: mayMutate,
    canDelete: mayMutate,
    attachments: attachments.map(toChatMessageAttachmentDto),
  };
}
