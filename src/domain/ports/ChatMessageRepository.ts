/**
 * messaging-inbox (F1) — mirror row of `ChatMessage` (design §1). Dates are
 * ISO 8601 strings (same convention as `ConversationRecord`).
 */
export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  /** messaging-bulk-inbox (F1) — `null` para un mensaje `origin:'bulk'` (salió por Twilio directo, sin id de Chatwoot). */
  chatwootMessageId: number | null;
  /** messaging-bulk-inbox (F1) — `'chatwoot'` (default) | `'bulk'`. */
  origin: string;
  /** messaging-bulk-inbox (F1) — clave de idempotencia del mensaje bulk; `null` para los de Chatwoot. */
  campaignRecipientId: string | null;
  direction: 'inbound' | 'outbound';
  content: string;
  senderName: string | null;
  chatwootCreatedAt: string;
  createdAt: string;
  /** messaging-inbox-notes (F1.5 fase D, NOTE-1) — always present (defaults false). */
  isPrivate: boolean;
  /**
   * inbox-template-send (MODEL-1/PORT-1) — SM sid de Twilio, clave de idempotencia
   * de `upsertTemplateMessage`. `null` para las filas `chatwoot`/`bulk` (PG trata
   * NULLs como distintos en el `@unique` — conviven N filas).
   */
  providerMessageId: string | null;
  /**
   * H1 (fix wave, idempotency-key server-side) — clave de idempotencia PROPIA
   * del REQUEST HTTP (UUID generado por el FE al abrir el modal de confirmación),
   * DISTINTA de `providerMessageId` (que es el SM sid de Twilio, solo se conoce
   * DESPUÉS de que el envío fue aceptado). `null` para toda fila sin key (FE
   * viejo que no la manda, o filas `chatwoot`/`bulk`). PG trata NULLs como
   * distintos en el `@unique` — conviven N filas NULL.
   */
  idempotencyKey: string | null;
  /**
   * messaging-inbox-notes (edit/delete) — usuario RBAC autor de la nota interna
   * (`isPrivate`). `null` para TODA fila histórica y para todos los mensajes públicos
   * (un `authorId` NULL sólo es editable/eliminable por un supervisor `messaging:manage`).
   * Es el `req.user.id` autenticado, NUNCA el `senderName` del echo de Chatwoot.
   */
  authorId: string | null;
  /** messaging-inbox-notes (edit/delete) — última edición de contenido (ISO). `null` = nunca editada. */
  editedAt: string | null;
  /** messaging-inbox-notes (edit/delete) — soft-delete (ISO). `null` = viva. La fila nunca se borra. */
  deletedAt: string | null;
}

export interface UpsertChatMessageInput {
  conversationId: string;
  chatwootMessageId: number;
  direction: 'inbound' | 'outbound';
  content: string;
  senderName?: string | null;
  chatwootCreatedAt: string;
  /** messaging-inbox-notes (F1.5 fase D, NOTE-1) — optional, defaults to false when absent. */
  isPrivate?: boolean;
  /**
   * messaging-inbox-notes (edit/delete) — autor RBAC. SET-ONCE: sólo se persiste en la
   * rama CREATE del upsert (el `update` idempotente del webhook con el mismo
   * chatwootMessageId NUNCA lo pisa). `SendMessage` sólo lo pasa cuando `isPrivate`.
   */
  authorId?: string | null;
}

/**
 * messaging-bulk-inbox (F1) — input para proyectar el mensaje bulk enviado al
 * inbox. `direction` es SIEMPRE `'outbound'`, `origin:'bulk'`, `chatwootMessageId=null`.
 * Idempotente por `campaignRecipientId` (una fila por recipient de campaña).
 */
export interface UpsertBulkChatMessageInput {
  conversationId: string;
  /** Clave de idempotencia — re-proyectar el mismo recipient NUNCA duplica. */
  campaignRecipientId: string;
  content: string;
  chatwootCreatedAt: string;
  senderName?: string | null;
}

/**
 * inbox-template-send (PORT-1) — input para proyectar el envío one-off de un
 * template disparado por un agente DESDE el hilo abierto (D3: NUNCA reusa
 * `upsertBulkMessage`/`CampaignInboxProjector` — acá SIEMPRE hay una
 * `conversationId` concreta, no se resuelve por teléfono). `direction` es
 * SIEMPRE `'outbound'`, `origin:'agent_template'`, `chatwootMessageId:null`,
 * `campaignRecipientId:null`, `isPrivate:false`.
 */
export interface UpsertTemplateChatMessageInput {
  conversationId: string;
  /** SM sid de Twilio — clave de idempotencia (upsert por este campo). */
  providerMessageId: string;
  content: string;
  senderName?: string | null;
  chatwootCreatedAt: string;
  /**
   * H1 (fix wave, idempotency-key server-side) — key del request HTTP original
   * (ver `ChatMessageRecord.idempotencyKey`). `undefined`/`null` → columna NULL
   * (comportamiento actual, sin dedup — FE viejo que no manda la key).
   */
  idempotencyKey?: string | null;
}

export interface ChatMessageRepository {
  /** Idempotent by `chatwootMessageId` (HOOK-4/INBOX-2) — re-processing the same message never duplicates. */
  upsertByChatwootMessageId(input: UpsertChatMessageInput): Promise<ChatMessageRecord>;
  /**
   * messaging-bulk-inbox (F1, PROYECCIÓN) — proyecta el mensaje bulk enviado como
   * un `ChatMessage` `outbound`/`origin:'bulk'`. IDEMPOTENTE por `campaignRecipientId`
   * (upsert) — best-effort/resumible: re-proyectar NO duplica la fila.
   */
  upsertBulkMessage(input: UpsertBulkChatMessageInput): Promise<ChatMessageRecord>;
  /**
   * inbox-template-send (PORT-1) — proyecta el envío one-off de un template al
   * hilo YA abierto por el agente. IDEMPOTENTE por `providerMessageId` (upsert) —
   * re-proyectar el MISMO SM sid nunca duplica la fila. Fila `origin:'agent_template'`.
   */
  upsertTemplateMessage(input: UpsertTemplateChatMessageInput): Promise<ChatMessageRecord>;
  /**
   * H1 (fix wave, idempotency-key server-side) — busca una fila YA proyectada
   * por su `idempotencyKey` propio. Usado por `SendTemplateMessage` como FAST
   * PATH (guard 0, ANTES de cualquier otro guard/side-effect): si esta key ya
   * resolvió en un envío exitoso anterior, se devuelve ESA fila sin re-invocar
   * `sendTemplate` — protege contra doble costo real en un retry de red tras el
   * accept de Twilio. También usado como backstop de recuperación tras una
   * colisión de `@unique` en carrera (dos sends concurrentes con la misma key).
   */
  findByIdempotencyKey(idempotencyKey: string): Promise<ChatMessageRecord | null>;
  /**
   * INBOX-3 — full history, ordered by `chatwootCreatedAt` ASC (oldest first).
   * messaging-inbox-notes (edit/delete) — SIGUE devolviendo las notas soft-deleted
   * (`deletedAt != null`): el FE las muestra como tombstone (deleted=true). Es el
   * contador `internalNoteCount` el que las excluye, NO este listado.
   */
  listByConversation(conversationId: string): Promise<ChatMessageRecord[]>;
  /**
   * messaging-inbox-notes (edit/delete) — actualiza EXCLUSIVAMENTE `content` +
   * `editedAt` de una nota interna (autorización ya validada por `EditInternalNote`).
   * No cambia `internalNoteCount` (editar no crea ni borra). `null` si no existe.
   */
  updateContent(id: string, content: string, editedAt: string): Promise<ChatMessageRecord | null>;
  /**
   * messaging-inbox-notes (edit/delete) — soft-delete: setea `deletedAt`, NUNCA borra
   * la fila. Recalcula `internalNoteCount` de la conversación (choke point, mismo
   * patrón que `lastPublicMessageDirection`). `null` si no existe.
   */
  softDelete(id: string, deletedAt: string): Promise<ChatMessageRecord | null>;
  /**
   * messaging-inbox-v2-media (Tanda 1 · MEDIA-2) — resolves a message's own mirror
   * row by its (internal) id. `DownloadChatMessageAttachment` uses this to recover
   * `conversationId` for the storage key (`messaging/{conversationId}/{attachmentId}.ext`).
   */
  findById(id: string): Promise<ChatMessageRecord | null>;
}
