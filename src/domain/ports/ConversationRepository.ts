import { PaginatedQuery, PaginatedResult } from '../../application/dto/pagination';

/**
 * messaging-inbox (F1) — mirror row of `Conversation` (design §1). Dates are
 * ISO 8601 strings, never raw Prisma `Date` objects (same convention as
 * `OwnershipTransferCase`/`ContractListItem`).
 */
/**
 * messaging-bulk-inbox (F1, etiqueta #1) — campaña asociada a una conversación,
 * JOIN-derived del lazo `CampaignRecipient(conversationId, campaignId)` (mismo
 * criterio "flat/JOIN-derived en el record" que `assigneeName`).
 */
export interface ConversationCampaignRef {
  id: string;
  name: string;
}

/**
 * conversation-labels (Ola 5) — etiqueta asignada a una conversación, JOIN-derived
 * de la join `ConversationLabelAssignment` (mismo criterio "flat/JOIN-derived en el
 * record" que `campaigns`). El FE pinta el chip con `name` + `color`.
 */
export interface ConversationLabelRef {
  id: string;
  name: string;
  color: string;
}

export interface ConversationRecord {
  id: string;
  /** messaging-bulk-inbox (F1) — `null` para una conversación `origin:'bulk'` aún no adoptada por Chatwoot (Fase 2). */
  chatwootConversationId: number | null;
  /** messaging-bulk-inbox (F1) — `'chatwoot'` (default) | `'bulk'`. */
  origin: string;
  contactName: string | null;
  contactPhone: string | null;
  /**
   * messaging-bulk-inbox (F1) — E164 CANÓNICO (`toWhatsAppE164(contactPhone)`), clave de
   * matcheo del bulk / Fase 2. NO `normalizePhone` (lossy con el "15" embebido → duplicados).
   */
  contactPhoneE164: string | null;
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
  /**
   * messaging-bulk-inbox (F1, etiqueta #1) — campañas de esta conversación
   * (JOIN-derived del lazo CampaignRecipient). `[]` cuando no participa en ninguna.
   */
  campaigns: ConversationCampaignRef[];
  /**
   * conversation-labels (Ola 5) — etiquetas de esta conversación (JOIN-derived de
   * `ConversationLabelAssignment`). `[]` cuando no tiene ninguna. LOCAL-only:
   * ningún write-path de Chatwoot las toca (igual que assigneeId/areaId) — solo
   * `setLabels` las escribe.
   */
  labels: ConversationLabelRef[];
  /**
   * inbox-views (Ola 1, VIEW-1) — dirección del ÚLTIMO mensaje NO-privado de la
   * conversación (`'inbound'` = el cliente habló último, `'outbound'` = el último
   * en hablar por WhatsApp fue un agente/sistema, `null` = sin mensajes públicos
   * todavía). Cache DESNORMALIZADO mantenido por los write-paths de
   * `ChatMessageRepository` (choke point: webhook/fetch-on-open/send/bulk/template
   * TODOS pasan por sus 3 upserts) — una nota interna (`isPrivate`) JAMÁS lo toca
   * (no cuenta como atención, misma disciplina que `bumpsPreview`/NOTE-3). Es lo
   * que hace O(1) el filtro/contador "Sin atender": la alternativa (derivar el
   * último mensaje por conversación en cada request) es un correlated subquery
   * que Prisma no expresa sin $queryRaw o un N+1 por fila.
   */
  lastPublicMessageDirection: 'inbound' | 'outbound' | null;
  /**
   * messaging-inbox-notes (edit/delete, COUNT) — contador DESNORMALIZADO de notas
   * internas VIVAS (`isPrivate=true AND deletedAt IS NULL`) de la conversación.
   * Mantenido por los write-paths de `ChatMessageRepository` (choke point, MISMO
   * patrón que `lastPublicMessageDirection`: recompute total, self-healing). Una nota
   * soft-deleted NO cuenta; el listado del hilo SÍ la sigue mostrando (tombstone).
   */
  internalNoteCount: number;
  /**
   * conversation-events (Ola 2) — ÚLTIMA vez que la conversación pasó a `resolved`
   * (ISO). Se LIMPIA a `null` al reabrir (refleja el estado ACTUAL). Lo mantiene
   * `SetConversationStatus` + el webhook, atómico con el cambio de `status`.
   */
  resolvedAt: string | null;
  /**
   * conversation-events (Ola 2) — PRIMERA resolución histórica (ISO). NUNCA se limpia
   * (base de "tiempo hasta primera resolución"). Backfill de históricas = `updatedAt` (aprox).
   */
  firstResolvedAt: string | null;
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
  /**
   * messaging-bulk-inbox (F1, etiqueta #1) — filtra las conversaciones que
   * participan en la campaña `campaignId` (JOIN Conversation×CampaignRecipient).
   */
  campaignId?: string;
  /**
   * conversation-labels (Ola 5) — filtra las conversaciones que tienen ASIGNADA la
   * label `labelId` (JOIN Conversation×ConversationLabelAssignment). AND independiente,
   * combinable con `assigneeId`/`unassigned`/`campaignId`/`status` sin precedencia
   * especial. Ambos adapters (`InMemoryConversationRepository`,
   * `PrismaConversationRepository`) MUST implementar la MISMA semántica vía el
   * builder compartido del where (`buildConversationWhere`/`applyFilters`).
   */
  labelId?: string;
  /**
   * inbox-resolve (LS-1) — filtro de CICLO DE VIDA con semántica de BUCKET, no de
   * match exacto para `'open'`. `Conversation.status` es String passthrough del
   * vocabulario de Chatwoot (schema `@default("open")`) — por webhook pueden llegar
   * `pending`/`snoozed`, que la UI de Prominense nunca setea pero el mirror puede
   * tener igual.
   *
   * - `'open'` → bucket ACTIVAS: `status != 'resolved'` (incluye `open` y cualquier
   *   passthrough no-resuelto como `pending`/`snoozed` — así ninguna fila queda
   *   invisible para ambos buckets a la vez).
   * - `'resolved'` → match EXACTO: `status === 'resolved'`.
   * - `'pending'` → conversation-events (Ola 2) — match EXACTO: `status === 'pending'`
   *   (subconjunto del bucket `'open'`). Añadido para el tile `currentPending` de
   *   `reports/overview`; misma semántica exacta que `'resolved'`. NO se acepta desde la
   *   URL del listado (la whitelist de la route sólo deja `open`/`resolved`), sólo lo usan
   *   los reports internamente.
   * - Ausente → sin filtro (comportamiento actual intacto, back-compat — misma
   *   convención "solo aplica cuando viene definido" que `assigneeId`/`campaignId`).
   *
   * Es un AND independiente, combinable con `assigneeId`/`unassigned`/`campaignId`
   * sin precedencia especial. Ambos adapters (`InMemoryConversationRepository`,
   * `PrismaConversationRepository`) MUST implementar la MISMA semántica.
   */
  status?: 'open' | 'resolved' | 'pending';
  /**
   * inbox-views (Ola 1, VIEW-1) — bucket "Sin atender": conversación NO-resuelta
   * (`status != 'resolved'`, mismo bucket LS-1 que `status:'open'`) cuyo
   * `lastPublicMessageDirection === 'inbound'` (el cliente habló último y ningún
   * agente respondió por WhatsApp; una nota interna NO atiende). `true` GANA
   * sobre `status` (el bucket ya lleva su propio filtro de ciclo de vida — mismo
   * molde de precedencia documentada que `assigneeId` sobre `unassigned`).
   * Combinable en AND con `assigneeId`/`unassigned`/`campaignId`. Ambos adapters
   * MUST implementar la MISMA semántica.
   */
  unattended?: boolean;
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
  /**
   * conversation-events (Ola 2) — timestamps derivados del ciclo de resolución, escritos
   * ATÓMICAMENTE junto al `status` por `SetConversationStatus`/el webhook (misma convención
   * "undefined = no tocar" del resto del input; `null` = limpiar, ej. `resolvedAt` al
   * reabrir). NO son campos LOCAL-only tipo assignee/area: derivan de `status` (Chatwoot-
   * sourced), así que co-viven acá y NUNCA los toca ningún otro camino (undefined = intactos).
   */
  resolvedAt?: string | null;
  firstResolvedAt?: string | null;
}

/**
 * messaging-bulk-inbox (F1, PROYECCIÓN) — input del write-path BULK, DELIBERADAMENTE
 * SEPARADO de `upsertByChatwootId`: nunca comparte método con el write-path de
 * Chatwoot (misma disciplina que `updateLocalFields`), así que jamás puede pisar
 * el mirror de Chatwoot por accidente. Busca la conversación MÁS RECIENTE con este
 * `contactPhoneE164` (cualquier origen); si existe, appendea (cae en el hilo
 * que el cliente YA tiene); si no, crea una `origin:'bulk'`.
 */
export interface UpsertBulkConversationInput {
  contactName?: string | null;
  contactPhone?: string | null;
  /** Bump del preview del inbox con el mensaje bulk recién enviado (outbound). */
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
}

/**
 * inbox-template-send (PORT-2) — patch para `bumpLastMessage`: escribe SOLO el
 * preview del inbox tras un envío one-off de template. Deliberadamente NO lleva
 * `canReply`/`status`: el template NUNCA abre la ventana de 24h (design D2).
 */
export interface BumpLastMessageInput {
  lastMessageAt: string;
  lastMessagePreview: string;
}

/**
 * convo-count — contador de interacciones del contacto para el panel de contexto
 * del inbox. 1 interacción = 1 fila `Conversation` (el mirror tiene UNA fila por
 * conversación de Chatwoot, que se REABRE in-place sin historial de transiciones
 * — no existe resolvedAt ni tabla de eventos — así que el COUNT de filas es el
 * único contador honesto disponible). Buckets con la MISMA semántica LS-1 del
 * filtro del inbox (`ConversationListQuery.status`):
 * - `open` = `status != 'resolved'` (incluye `pending`/`snoozed` passthrough).
 * - `resolved` = match EXACTO `status === 'resolved'`.
 * Invariante: `total === open + resolved` (ninguna fila invisible para ambos).
 */
export interface ConversationStatusCounts {
  total: number;
  open: number;
  resolved: number;
}

export interface ConversationRepository {
  findById(id: string): Promise<ConversationRecord | null>;
  findByChatwootId(chatwootConversationId: number): Promise<ConversationRecord | null>;
  upsertByChatwootId(input: UpsertConversationInput): Promise<ConversationRecord>;
  /**
   * messaging-bulk-inbox (F1, PROYECCIÓN) — write-path BULK por E164 CANÓNICO
   * (`toWhatsAppE164`, NO `normalizePhone` lossy), SEPARADO de `upsertByChatwootId`
   * (ver `UpsertBulkConversationInput`). Idempotente a nivel conversación: appendea a
   * la más reciente con ese `phoneE164` o crea una `origin:'bulk'` (`chatwootConversationId=null`).
   */
  upsertBulkByPhone(phoneE164: string, input: UpsertBulkConversationInput): Promise<ConversationRecord>;
  /**
   * messaging-bulk-inbox (F1, FASE 2 — reconciliación AISLADA) — si existe una
   * conversación `origin:'bulk'` con `chatwootConversationId=null` y el mismo
   * `contactPhoneE164` (E164 canónico, cross-format safe), la ADOPTA in-place
   * seteándole `chatwootConversationId` (CONSERVA el `id` → `recipient.conversationId`
   * sigue válido, sin repoint). NUNCA toca una conversación Chatwoot existente y NO
   * adopta si `chatwootConversationId` ya está tomado (evita duplicados/colisión de
   * UNIQUE). Devuelve la adoptada, o `null` si no hubo adopción (no-op seguro).
   */
  adoptBulkConversation(phoneE164: string, chatwootConversationId: number): Promise<ConversationRecord | null>;
  /**
   * INBOX-1 — paginated listing, ordered by `lastMessageAt` DESC (nulls last,
   * never-messaged conversations sort to the bottom). F1.5-C2 extends the query
   * with the assignment filter (Mine/Unassigned/All).
   */
  list(query: ConversationListQuery): Promise<PaginatedResult<ConversationRecord>>;
  /**
   * inbox-views (Ola 1, COUNT-2) — cantidad de conversaciones que matchean el
   * MISMO `ConversationListQuery` que `list` (idéntica semántica de filtros —
   * en ambos adapters `list` y `count` comparten el builder del where, una sola
   * fuente de verdad: el número del badge SIEMPRE coincide con el total del
   * listado). Anti-N+1: agregación en el adapter (`COUNT`), jamás trae filas.
   * `page`/`limit` se ignoran (contar no pagina).
   */
  count(query: ConversationListQuery): Promise<number>;
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
  /**
   * conversation-labels (Ola 5) — REEMPLAZA por completo el set de labels de la
   * conversación por `labelIds` (no acumula: las que no estén en el nuevo set se
   * quitan; `[]` limpia todas). LOCAL-only (Chatwoot nunca las ve), SEPARADO de
   * `upsertByChatwootId`/`updateLocalFields` — ningún write-path de Chatwoot puede
   * tocarlas. Idempotente (la join tiene UNIQUE(conversationId,labelId)). Devuelve
   * `null` si la conversación no existe; el use case (`SetConversationLabels`) ya
   * valida existencia + que cada labelId exista antes de llamar. Asume `labelIds`
   * ya deduplicados y validados por el use case.
   */
  setLabels(conversationId: string, labelIds: string[]): Promise<ConversationRecord | null>;
  /**
   * inbox-template-send (PORT-2) — write-path SEPARADO del bump de preview tras
   * un envío one-off de template. Escribe EXCLUSIVAMENTE `lastMessageAt`/
   * `lastMessagePreview` — `canReply`, `status`, `assigneeId`, `areaId`,
   * `chatwootConversationId`, `origin` y todo lo demás quedan INTACTOS (misma
   * disciplina de write-paths separados que `updateLocalFields`/`upsertBulkByPhone`:
   * ningún camino nuevo puede pisar el cache de Chatwoot ni la regla de plataforma
   * "el template no abre la ventana", design D2). `null` si la conversación no existe.
   */
  bumpLastMessage(conversationId: string, patch: BumpLastMessageInput): Promise<ConversationRecord | null>;
  /**
   * convo-count — counts por status de TODAS las conversaciones del contacto,
   * agrupadas por `contactPhoneE164` (la clave de identidad CANÓNICA del contacto
   * que este port ya usa en `upsertBulkByPhone`/`adoptBulkConversation`; indexada
   * en el schema). Anti-N+1: agregación en el adapter (groupBy/count), JAMÁS
   * traer filas. Degradación conocida y aceptada: filas hermanas con
   * `contactPhoneE164 = null` (backfill best-effort pre-migración) no se cuentan
   * — misma "degradación segura" que el matcheo del bulk ya asume.
   */
  countByContactPhoneE164(phoneE164: string): Promise<ConversationStatusCounts>;
  /**
   * conversation-events (Ola 2, reports/overview) — cantidad de conversaciones cuyo
   * `createdAt` cae en el rango SEMI-ABIERTO `[fromIso, toIso)`. Fuente COMPLETA de
   * `createdInRange`: `createdAt` existe en TODA fila (a diferencia de contar eventos
   * 'created', que sólo cubre lo registrado post-deploy y omite las históricas/bulk).
   * Anti-N+1: un solo `COUNT`, jamás trae filas.
   */
  countCreatedBetween(fromIso: string, toIso: string): Promise<number>;
}
