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
  /** INBOX-3 — full history, ordered by `chatwootCreatedAt` ASC (oldest first). */
  listByConversation(conversationId: string): Promise<ChatMessageRecord[]>;
  /**
   * messaging-inbox-v2-media (Tanda 1 · MEDIA-2) — resolves a message's own mirror
   * row by its (internal) id. `DownloadChatMessageAttachment` uses this to recover
   * `conversationId` for the storage key (`messaging/{conversationId}/{attachmentId}.ext`).
   */
  findById(id: string): Promise<ChatMessageRecord | null>;
}
