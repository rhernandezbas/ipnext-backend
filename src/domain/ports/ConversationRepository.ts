import { PaginatedQuery, PaginatedResult } from '../../application/dto/pagination';

/**
 * messaging-inbox (F1) — mirror row of `Conversation` (design §1). Dates are
 * ISO 8601 strings, never raw Prisma `Date` objects (same convention as
 * `OwnershipTransferCase`/`ContractListItem`).
 */
export interface ConversationRecord {
  id: string;
  chatwootConversationId: number;
  contactName: string | null;
  contactPhone: string | null;
  status: string;
  /** Cache of Chatwoot's `can_reply` — read by SendMessage, never recomputed locally (design §4). */
  canReply: boolean;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  /**
   * F1.5-C2 (asignación) — assigneeId/areaId son campos EXCLUSIVAMENTE LOCALES
   * del mirror (Chatwoot nunca los ve). `assigneeName`/`areaName`/`areaColor`
   * son JOIN-derived (resueltos por el adapter vía Prisma `include`/seed
   * in-memory) — mismo criterio que `Ticket.assigneeName` (JOIN-derived de
   * Admin/RbacUser.name). Solo `updateLocalFields` los escribe; NINGÚN otro
   * método de este port (`upsertByChatwootId` incluido) los toca.
   */
  assigneeId: string | null;
  assigneeName: string | null;
  areaId: string | null;
  areaName: string | null;
  areaColor: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * F1.5-C2 (asignación) — extiende `PaginatedQuery` con el filtro server-side de
 * asignación del inbox (Mine/Unassigned/All). Definido acá (no en
 * `dto/pagination.ts`) para no acoplar el tipo genérico de paginación a un
 * concepto propio de messaging — otros consumidores de `PaginatedQuery` no se
 * ven afectados (superset de campos opcionales, 100% compatible).
 *
 * `assigneeId` truthy tiene PRIORIDAD sobre `unassigned` cuando (por error del
 * caller) ambos llegaran seteados — ver `ListConversations`/route.
 */
export interface ConversationListQuery extends PaginatedQuery {
  assigneeId?: string;
  unassigned?: boolean;
}

/**
 * F1.5-C2 (asignación) — patch LOCAL-only. `undefined` = no tocar (mismo
 * convenio "undefined = no tocar" que `UpsertConversationInput`); `null` =
 * desasignar/quitar área. Deliberadamente un método SEPARADO de
 * `upsertByChatwootId`: esa separación estructural es lo que garantiza que
 * ningún camino de escritura impulsado por Chatwoot pueda tocar estos campos
 * por accidente (no comparten ni siquiera el mismo método).
 */
export interface UpdateConversationLocalFieldsInput {
  assigneeId?: string | null;
  areaId?: string | null;
}

/**
 * Upsert keyed by `chatwootConversationId` (unique). Undefined optional fields
 * are left UNTOUCHED on update; on create they fall back to schema defaults
 * (`status='open'`, `canReply=false`). One method serves all 3 HOOK-4 event
 * handlers plus the INBOX-2 fetch-on-open refresh — each caller only passes
 * the fields it actually knows about.
 */
export interface UpsertConversationInput {
  chatwootConversationId: number;
  contactName?: string | null;
  contactPhone?: string | null;
  status?: string;
  canReply?: boolean;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
}

export interface ConversationRepository {
  findById(id: string): Promise<ConversationRecord | null>;
  findByChatwootId(chatwootConversationId: number): Promise<ConversationRecord | null>;
  upsertByChatwootId(input: UpsertConversationInput): Promise<ConversationRecord>;
  /**
   * INBOX-1 — paginated listing, ordered by `lastMessageAt` DESC (nulls last,
   * never-messaged conversations sort to the bottom). F1.5-C2 extends the query
   * with the assignment filter (Mine/Unassigned/All).
   */
  list(query: ConversationListQuery): Promise<PaginatedResult<ConversationRecord>>;
  /**
   * F1.5-C2 (asignación) — actualiza EXCLUSIVAMENTE assigneeId/areaId (LOCAL,
   * nunca Chatwoot). Devuelve `null` si la conversación no existe — los use
   * cases (`AssignConversation`/`SetConversationArea`) ya validan existencia
   * antes de llamar, así que en la práctica nunca deberían ver ese `null`.
   */
  updateLocalFields(
    conversationId: string,
    patch: UpdateConversationLocalFieldsInput,
  ): Promise<ConversationRecord | null>;
}
