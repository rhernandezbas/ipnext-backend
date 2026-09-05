/**
 * messaging-inbox (F1) — port for the Chatwoot Application API (design §3).
 * Adapter: `infrastructure/adapters/chatwoot/HttpChatwootGateway.ts` (B3).
 * Types here are DOMAIN shapes (already mapped from Chatwoot's wire format) —
 * use cases NEVER see raw Chatwoot JSON.
 */

export interface ChatwootConversationDto {
  id: number;
  /**
   * H3 — `undefined` means the field was ABSENT from Chatwoot's response (the
   * adapter must NOT coerce that to `null`): callers forward it straight into
   * `UpsertConversationInput`, where `undefined` = leave untouched and `null` =
   * a real known value to write. Coercing absence to `null` here would let a
   * partial GET response wipe out a good value already in the mirror.
   */
  contactName?: string | null;
  contactPhone?: string | null;
  /**
   * Residuo #3 — same H3 rule as `contactName`/`contactPhone`: `undefined` means
   * ABSENT from Chatwoot's response, forwarded straight into `UpsertConversationInput`
   * where `undefined` = leave untouched. Defaulting absence to `'open'` here (the old
   * behavior) let a partial GET response CLOBBER a real status already in the mirror
   * during fetch-on-open — exactly the asymmetry the webhook path already avoided.
   */
  status?: string;
  /**
   * Cache of Chatwoot's `can_reply` — SendMessage reads this from the mirror, never
   * recomputed locally. Residuo #3 — `undefined` (field absent), NOT a defaulted
   * `false`, for the same clobber-avoidance reason as `status` above.
   */
  canReply?: boolean;
  lastActivityAt?: string | null;
}

/**
 * messaging-inbox-v2-media (F1.5 fase A, Tanda 1 · MEDIA-1 fetch-on-open parity) —
 * domain shape of a Chatwoot attachment, already mapped from the wire (snake_case →
 * camelCase) by `HttpChatwootGateway`. `GetConversation.syncFromChatwoot` filters by
 * `fileType` (only image/audio/video/file get a `ChatMessageAttachment` row) — the
 * gateway itself does no filtering, same split of responsibility as `direction`.
 */
export interface ChatwootMessageAttachmentDto {
  id: number;
  fileType: string;
  contentType: string;
  filename: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  sourceUrl: string;
  thumbSourceUrl: string | null;
}

export interface ChatwootMessageDto {
  id: number;
  /** null = filtered by design §7 (activity/template message_type — not persisted). */
  direction: 'inbound' | 'outbound' | null;
  content: string;
  senderName: string | null;
  createdAt: string;
  /**
   * H2 residual — true for an internal agent note (Chatwoot's `private` flag), same
   * meaning as `ChatwootWebhookPayload.private` in `ReceiveChatwootWebhook`. The GET
   * path (`HttpChatwootGateway.listMessages`, consumed by `GetConversation`'s
   * fetch-on-open) has no other channel to signal this — `direction` alone isn't
   * enough (a private note is still message_type "outgoing"/1 → 'outbound'). Callers
   * MUST treat `private === true` the same as `direction === null`: never persisted,
   * never bumps the preview.
   */
  private?: boolean;
  /** MEDIA-1 — parity with the webhook's `attachments[]` (same Chatwoot API shape). */
  attachments?: ChatwootMessageAttachmentDto[];
}

/**
 * messaging-inbox-v2-media (F1.5 fase A, Tanda 2 · SEND-4) — a file the agent is
 * SENDING, in-memory (multer's `memoryStorage`), never touching disk. Co-located
 * with `ChatwootMessageAttachmentDto` (its inbound counterpart) since both describe
 * the same wire-adjacent shape from opposite directions.
 */
export interface OutboundAttachmentFile {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

/**
 * campaign-chatwoot-label (design D1.a) — ficha de un label del catálogo REAL de
 * Chatwoot (`GET/POST /accounts/2/labels`). Sin `id` (YAGNI, D1.a): los tags de
 * conversación se aplican y resuelven POR TÍTULO (`addConversationLabels`), nunca
 * por id — un `id` acá sería un campo muerto.
 */
export interface ChatwootLabelDto {
  title: string;
  color: string;
}

export interface ChatwootGateway {
  listConversations(): Promise<ChatwootConversationDto[]>;
  getConversation(chatwootConversationId: number): Promise<ChatwootConversationDto>;
  listMessages(chatwootConversationId: number): Promise<ChatwootMessageDto[]>;
  /**
   * SEND-4 — `files` is additive/optional: WITHOUT it, the JSON path is unchanged
   * (F1, zero regression). WITH at least one file, the adapter MUST switch to a
   * multipart/form-data POST (`HttpChatwootGateway`).
   *
   * messaging-inbox-notes (F1.5 fase D, NOTE-4) — `options.private` is additive/optional
   * (4th param, same criterion as `files?` in SEND-4): WITHOUT it (or `private:false`),
   * the request is byte-for-byte identical to today (no `private` field at all — not
   * even a `false`). WITH `private:true`, the adapter MUST include it in BOTH the JSON
   * body and the multipart form (`form.append('private','true')`).
   */
  sendMessage(
    chatwootConversationId: number,
    content: string,
    files?: OutboundAttachmentFile[],
    options?: { private?: boolean },
  ): Promise<ChatwootMessageDto>;
  /** F2: not consumed by any F1 use case; kept in the port for contract completeness. */
  searchContact(query: string): Promise<{ id: number; name: string | null; phone: string | null }[]>;
  /** Invoked ONLY by `scripts/registerChatwootWebhook.ts` (one-shot operational setup), not by app.ts. */
  registerWebhook(url: string, secret: string): Promise<void>;
  /**
   * messaging-inbox-productivity (F1.5 fase C, STATUS-1) — toggles a conversation's
   * status in Chatwoot (resolver/reabrir/marcar pendiente). Independent of
   * `canReply` (the 24h reply-window cache): this NEVER touches the window, only
   * Chatwoot's own status field. Same single-outcome-on-failure convention as
   * `sendMessage`/`registerWebhook`: ANY axios failure (network/timeout/4xx/5xx)
   * throws `ChatwootUnavailableError`.
   *
   * conversation-snooze (Ola 6c) — `'snoozed'` uses the SAME `toggle_status` endpoint the
   * Chatwoot UI itself uses, passing `snoozed_until` (epoch seconds) so Chatwoot's own
   * auto-reopen also fires. `snoozedUntil` (ISO) is REQUIRED when status is `'snoozed'` and
   * IGNORED otherwise. Kept as a single method (not a separate `snooze`) because Chatwoot
   * models it as one status transition, not a distinct operation.
   */
  setStatus(
    chatwootConversationId: number,
    status: 'open' | 'resolved' | 'pending' | 'snoozed',
    snoozedUntil?: string | null,
  ): Promise<void>;
  /**
   * messaging-inbox-v2-media (Tanda 1 · MEDIA-2) — follows Chatwoot's `sourceUrl`
   * (`data_url`, a stable 301) WITHOUT forwarding any auth header (verified live: the
   * signed redirect needs no `api_access_token`). Any failure (network/timeout/4xx/5xx)
   * throws `ChatwootUnavailableError`, same single-outcome convention as the rest of
   * this port.
   *
   * fix-be #1 (HIGH) — `options.maxBytes` MUST be forwarded down to the underlying
   * HTTP client as a hard `maxContentLength`/`maxBodyLength` ceiling: the caller
   * (`DownloadChatMessageAttachment`) already re-validates size AFTER the buffer is
   * fully in memory, which is too late to prevent an OOM on a lied-about/absent
   * `file_size`. Passing it here lets the adapter abort mid-stream instead.
   */
  downloadAttachment(
    url: string,
    options?: { maxBytes?: number },
  ): Promise<{ buffer: Buffer; contentType: string }>;
  /**
   * chatwoot-hub-sendpath (design D2.a, CHW-1) — envía un template WhatsApp sobre una
   * conversación YA EXISTENTE (path del hilo, `SendTemplateMessage` flag ON). `name`/
   * `language` deben coincidir con el `friendly_name`/`language` del template en el
   * catálogo `channel.content_templates` de Chatwoot (matcher verificado en vivo,
   * exploración §5) — vienen del `TemplateDto` que YA resolvió el gate de aprobación
   * (D7), no de un lookup nuevo. `processedParams` mapea 1:1 sin transformación (mismo
   * `Record<string,string>` que hoy le mandamos a Twilio). `content` es el texto
   * renderizado a mostrar en el hilo. Cualquier falla de axios (red/timeout/4xx/5xx)
   * MUST lanzar `ChatwootUnavailableError` (mismo criterio único del resto del port,
   * CHW-7) — un template inexistente/fuera-de-ventana responde 201 igual (Chatwoot lo
   * marca `failed` async, ver `setStatus`/webhook `message_updated`, D6).
   */
  sendTemplateMessage(
    chatwootConversationId: number,
    params: { name: string; language: string; processedParams: Record<string, string>; content: string },
  ): Promise<{ chatwootMessageId: number; content: string }>;
  /**
   * chatwoot-hub-sendpath (design D2.b, CHW-2) — ensure-on-404 de contacto+conversación+
   * primer mensaje (path bulk, `SendCampaign` flag ON, recipient SIN
   * `chatwootConversationId` previo). El adapter intenta PRIMERO `POST /conversations`
   * por `source_id` EXACTO (`'whatsapp:'+phoneE164`) — UNA sola llamada cuando el
   * `ContactInbox` ya existe (happy path, cero regresión). chatwoot-new-contact-404
   * (verificado en vivo y contra el fuente upstream) CORRIGE la premisa previa de este
   * docblock: Chatwoot NO hace find-or-create ATÓMICO acá — su `before_action
   * :contact_inbox` hace un FIND por `(source_id, inbox_id)` y responde 404 cuando no
   * existe. Sólo ante ESE 404 el adapter MUST asegurar el contacto y su `ContactInbox`
   * (create-si-no-existe, o buscar+vincular ante un 422 de teléfono duplicado) y MUST
   * reintentar `POST /conversations` EXACTAMENTE una vez con el `source_id` que Chatwoot
   * devolvió en la respuesta del ensure — MUST NOT re-derivarlo de un formato asumido
   * (inmune a una futura migración de canal `Channel::TwilioSms` → `Channel::Whatsapp`,
   * que cambia el shape del `source_id`). `name` se envía sólo si NO está vacío (puede
   * ser `''` para recipients CSV). Mismo criterio único de fallo que el resto del port
   * (`ChatwootUnavailableError`), ahora con mensaje que identifica el PASO Chatwoot que
   * falló y su STATUS HTTP (CHW-7) — nunca el texto crudo del cliente HTTP.
   *
   * F6 (fix wave) — `chatwootMessageId` es `number | null`: si la respuesta del create no expone
   * el message id de forma fiable, el adapter devuelve `null` (NUNCA `NaN`, que Prisma Int rechaza).
   * Con null, `SendCampaign`/`PrismaCampaignInboxProjector` SALTEAN el upsert del mensaje pero
   * SIEMPRE crean la Conversation + preservan el link recipient->conversacion; el eco
   * `message_created` del webhook repone el mensaje despues.
   */
  createConversationWithTemplate(params: {
    phoneE164: string;
    name?: string | null;
    templateName: string;
    language: string;
    processedParams: Record<string, string>;
    content: string;
  }): Promise<{ chatwootConversationId: number; chatwootMessageId: number | null }>;
  /**
   * campaign-chatwoot-label (design D1.b, CLBL-1) — catálogo REAL de labels de la
   * cuenta (`GET /accounts/2/labels`). Alimenta el picker del composer FE. Mismo
   * criterio único de fallo del resto del port: cualquier error de axios
   * (red/timeout/4xx/5xx) → `ChatwootUnavailableError`.
   */
  listAccountLabels(): Promise<ChatwootLabelDto[]>;
  /**
   * campaign-chatwoot-label (design D1.b, CLBL-2) — crea la ficha COMPLETA de un
   * label en el catálogo (`POST /accounts/2/labels`, requiere administrator del
   * lado Chatwoot). Un `title` duplicado (unique por cuenta) responde 4xx → cae en
   * el mismo `ChatwootUnavailableError` (limitación conocida, D2/D8: no se
   * distingue un 409 semántico).
   */
  createAccountLabel(params: { title: string; color: string }): Promise<ChatwootLabelDto>;
  /**
   * campaign-chatwoot-label (design D1.c/D2, CLBL-3/CLBL-4/CLBL-5) — agrega
   * `labels` (el DELTA a agregar, NO el set completo) a una conversación. La
   * mecánica GET-unión-POST (Chatwoot REEMPLAZA el set completo en el POST de
   * tags — `Labelable#update_labels`) vive DENTRO del adapter: el use case NO
   * sabe que Chatwoot reemplaza, solo pide "agregá este label". Idempotente
   * (unión de un set consigo mismo = no-op) — reintentos/re-aplicaciones seguras.
   */
  addConversationLabels(chatwootConversationId: number, labels: string[]): Promise<void>;

  /**
   * ai-assistant-cobranzas (4.10 / D10 / ACT-4) — desasigna la conversación EN CHATWOOT
   * (`POST /conversations/:id/assignments` con `assignee_id: 0`, que es como Chatwoot
   * expresa "sin asignar").
   *
   * Existe porque `AssignConversation` —el use case humano— escribe SÓLO el espejo local
   * (`Conversation.assigneeId`) y jamás llama a Chatwoot. Los agentes trabajan en Chatwoot,
   * así que sin este método el "desasignar" del bot sería invisible justo donde importa.
   */
  unassignConversation(chatwootConversationId: number): Promise<void>;
}
