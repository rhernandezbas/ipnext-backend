import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import {
  ChatwootConversationDto,
  ChatwootGateway,
  ChatwootLabelDto,
  ChatwootMessageDto,
  ChatwootMessageAttachmentDto,
  OutboundAttachmentFile,
} from '@domain/ports/ChatwootGateway';
import { ChatwootUnavailableError } from '@domain/errors/messaging';

/**
 * SEND-4/SEND-8 — the send POST is SYNCHRONOUS (the agent waits for the 201), unlike
 * `downloadAttachment`'s fire-and-forget/scheduled path. An explicit `timeout` turns a
 * hung multipart upload into a controlled 503 (`ChatwootUnavailableError`) BEFORE any
 * proxy/ingress in front of this backend cuts it with a bare 504 — the exact class of
 * bug this repo already swept twice (`77a6fc97`). Value left generous (uploads can be
 * legitimately slow) but finite — never `Infinity`/unset.
 */
const SEND_TIMEOUT_MS = 60_000;
/**
 * fix-be #1 pattern (same reasoning as `downloadAttachment`'s `maxBytes`) — caps the
 * multipart request body. `MAX_FILES=10` × the 'file' fileType ceiling (100MB) is the
 * theoretical worst case; a request that big is already rejected by the route's own
 * multer limits (SEND-6) long before reaching this adapter, so 200MB here is a
 * generous-but-finite defensive ceiling, NOT the "tope total exacto" left open in
 * `spec-send.md`'s Decisiones abiertas.
 */
const SEND_MAX_BODY_LENGTH = 200 * 1024 * 1024;

/** Respuesta cruda de un GET binario, desacoplada de axios para poder fakearla en tests. */
export interface RawBinaryResponse {
  data: ArrayBuffer;
  headers: Record<string, unknown>;
}

/** fix-be #1 (HIGH) — hard ceiling forwarded down to axios' `maxContentLength`/`maxBodyLength`. */
export interface RawGetOptions {
  maxBytes?: number;
}

/**
 * fix-be #1 (HIGH) — conservative absolute fallback when no `maxBytes` is given
 * (defensive: this should never happen in practice, `DownloadChatMessageAttachment`
 * always passes one, but a bare axios.get with NO ceiling at all is exactly the bug
 * being fixed here). Matches the highest per-fileType ceiling ('file', 100MB).
 */
const DOWNLOAD_MAX_BYTES_DEFAULT = 100 * 1024 * 1024;
/** fix-be #1 (HIGH) — a hung `data_url` (no response at all) must not leave the
 * fire-and-forget's promise pending forever: that keeps `inFlight`/the scheduler's
 * `DistributedLock` held indefinitely on every replica. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * chatwoot-new-contact-404 (CHW-2/CHW-7) — status HTTP de un error de axios, o `null`
 * si no fue una respuesta HTTP (red/timeout, `err.response` ausente). Usado ANTES de
 * `this.call` en `createConversationWithTemplate`/`ensureContactInbox` para decidir si
 * corresponde el ensure-on-404 — `this.call` sigue siendo el criterio único de fallo
 * para el resto del port (12 operaciones, CHW-7), sin tocarlo (blast radius acotado).
 */
function httpStatusOf(err: unknown): number | null {
  const status = (err as { response?: { status?: unknown } } | null | undefined)?.response?.status;
  return typeof status === 'number' ? status : null;
}

/**
 * chatwoot-new-contact-404 (CHW-7) — error tipado que nombra el PASO Chatwoot que
 * falló y su STATUS HTTP, nunca el texto crudo de axios (`err.message` literal
 * "Request failed with status code 404" que el operador veía antes de este fix).
 * Sin status HTTP (red/timeout) el mensaje dice "— sin respuesta" en vez de un status
 * inexistente. `step` usa los mismos 4 valores documentados en el design de este change.
 */
function chatwootStepError(step: string, err: unknown): ChatwootUnavailableError {
  const status = httpStatusOf(err);
  return new ChatwootUnavailableError(
    status !== null ? `Chatwoot: ${step} — HTTP ${status}` : `Chatwoot: ${step} — sin respuesta`,
  );
}

/**
 * chatwoot-new-contact-404 (fix wave FW2, MEDIUM) — discrimina el ÚNICO 422 de `POST
 * /contacts` que dispara la resolución por búsqueda (design §Data Flow: "teléfono ya
 * existe") de cualquier OTRO 422 de validación (`inbox_id` inexistente, `phone_number`
 * mal formado, etc.). Inspecciona el body de la respuesta de Chatwoot (`message`, o el
 * shape de validation errors de Rails `{errors:{campo:[...]}}` / `{errors:[...]}`) —
 * un 422 sin ese indicio NUNCA se trata como "teléfono duplicado".
 */
function isDuplicatePhoneConflict(err: unknown): boolean {
  const data = (err as { response?: { data?: unknown } } | null | undefined)?.response?.data;
  const record = data as Record<string, unknown> | null | undefined;
  const texts: string[] = [];
  if (typeof record?.['message'] === 'string') texts.push(record['message'] as string);
  const errors = record?.['errors'];
  if (typeof errors === 'string') {
    texts.push(errors);
  } else if (Array.isArray(errors)) {
    for (const e of errors) if (typeof e === 'string') texts.push(e);
  } else if (errors && typeof errors === 'object') {
    for (const v of Object.values(errors as Record<string, unknown>)) {
      if (typeof v === 'string') texts.push(v);
      if (Array.isArray(v)) for (const e of v) if (typeof e === 'string') texts.push(e);
    }
  }
  return texts.some((t) => /already\s+(been\s+)?taken|already\s+exists/i.test(t));
}

export interface HttpChatwootGatewayOptions {
  baseUrl: string;
  accountId: string;
  inboxId: string;
  apiToken: string;
  /** Inyectable para tests (AxiosInstance fake). En prod se crea internamente. */
  http?: AxiosInstance;
  /**
   * messaging-inbox-v2-media (Tanda 1 · MEDIA-2) — GET binario CRUDO usado por
   * `downloadAttachment`, deliberadamente SEPARADO de `this.http` (que carga el header
   * `api_access_token` por default): el `sourceUrl` de Chatwoot no lo necesita (la firma
   * del redirect ES la auth) y reenviarlo sería un leak de credencial. Inyectable en tests.
   */
  rawGet?: (url: string, options?: RawGetOptions) => Promise<RawBinaryResponse>;
}

/**
 * HttpChatwootGateway — cliente HTTP de la Application API de Chatwoot v1 (design §3).
 * Clona el patrón de `HttpRadiusOrchestratorGateway` (axios.create en el ctor, SIN
 * retry/backoff — Chatwoot corre en nuestro VPS `.37`, no es un 3ro flapeante).
 *
 * A diferencia del orchestrator (que distingue 4xx-rechazado de 5xx-inalcanzable), acá
 * el spec (SEND-3/ROB-1) define UN solo resultado de fallo: cualquier error de axios
 * (red/timeout/4xx/5xx) → `ChatwootUnavailableError`.
 *
 * NOTA (design §Open Questions, aún sin cerrar): el mapeo de `meta.sender.phone_number`/
 * `name`, `can_reply` en GET .../conversations/:id, y el `message_type` exacto de
 * notas internas quedan best-effort hasta verificarlos contra un webhook/response real
 * de Chatwoot v4.13.0 en `.37` — no se pudo verificar en vivo durante este batch.
 */
export class HttpChatwootGateway implements ChatwootGateway {
  private readonly http: AxiosInstance;
  private readonly accountId: string;
  private readonly inboxId: string;
  private readonly rawGet: (url: string, options?: RawGetOptions) => Promise<RawBinaryResponse>;

  constructor(opts: HttpChatwootGatewayOptions) {
    this.accountId = opts.accountId;
    this.inboxId = opts.inboxId;
    this.http =
      opts.http ??
      axios.create({
        baseURL: opts.baseUrl,
        headers: { api_access_token: opts.apiToken },
      });
    // Bare axios.get — NOT this.http, NOT axios.create: no baseURL, no default headers,
    // so the api_access_token can never leak to sourceUrl or a redirect target.
    //
    // fix-be #1 (HIGH) — `maxContentLength`/`maxBodyLength` MUST be set: without them
    // axios buffers the ENTIRE response body before `DownloadChatMessageAttachment`
    // gets a chance to size-check it, so a lied-about/absent `file_size` OOMs the
    // process. Setting them makes axios abort mid-stream instead. `timeout` guards
    // the other half of the same bug: a `data_url` that never responds used to leave
    // the fire-and-forget's promise pending forever, which never releases the
    // scheduler's `inFlight`/`DistributedLock` on any replica.
    this.rawGet =
      opts.rawGet ??
      ((url: string, options?: RawGetOptions) =>
        axios.get<ArrayBuffer>(url, {
          responseType: 'arraybuffer',
          maxContentLength: options?.maxBytes ?? DOWNLOAD_MAX_BYTES_DEFAULT,
          maxBodyLength: options?.maxBytes ?? DOWNLOAD_MAX_BYTES_DEFAULT,
          timeout: DOWNLOAD_TIMEOUT_MS,
        }));
  }

  private accountPath(suffix: string): string {
    return `/api/v1/accounts/${encodeURIComponent(this.accountId)}${suffix}`;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new ChatwootUnavailableError(err instanceof Error ? err.message : String(err));
    }
  }

  async listConversations(): Promise<ChatwootConversationDto[]> {
    const { data } = await this.call(() =>
      this.http.get(this.accountPath('/conversations'), { params: { inbox_id: this.inboxId } }),
    );
    return extractRows(data).map(toConversationDto);
  }

  async getConversation(chatwootConversationId: number): Promise<ChatwootConversationDto> {
    const { data } = await this.call(() =>
      this.http.get(this.accountPath(`/conversations/${chatwootConversationId}`)),
    );
    return toConversationDto(data);
  }

  async listMessages(chatwootConversationId: number): Promise<ChatwootMessageDto[]> {
    const { data } = await this.call(() =>
      this.http.get(this.accountPath(`/conversations/${chatwootConversationId}/messages`)),
    );
    return extractRows(data).map(toMessageDto);
  }

  /**
   * SEND-4 — WITHOUT `files` (undefined/empty), conserves the exact F1 JSON path
   * (cero regresión, verified by `HttpChatwootGateway.test.ts`). WITH at least one
   * file, switches to a multipart/form-data POST: one `attachments[]` part per file
   * (buffer + filename + contentType) alongside `content`/`message_type`, with an
   * explicit `timeout`/`maxBodyLength`/`maxContentLength` (SEND-8) so a hung upload
   * resolves as `ChatwootUnavailableError` instead of hanging the request. The
   * response is mapped by the SAME `toMessageDto` as the JSON path — already
   * MEDIA-1-aware of `attachments[]` (`id`/`data_url` per file), which is the
   * pegamento `SendMessage`'s post-OK mirror (SEND-5) depends on.
   */
  async sendMessage(
    chatwootConversationId: number,
    content: string,
    files?: OutboundAttachmentFile[],
    options?: { private?: boolean },
  ): Promise<ChatwootMessageDto> {
    if (files && files.length > 0) {
      const form = new FormData();
      form.append('content', content);
      form.append('message_type', 'outgoing');
      // messaging-inbox-notes (NOTE-4) — only appended when truthy: an ABSENT field is
      // the compat baseline (F1, zero regression), never a noisy `private=false`.
      if (options?.private) form.append('private', 'true');
      for (const file of files) {
        form.append('attachments[]', file.buffer, {
          filename: file.filename,
          contentType: file.contentType,
        });
      }
      const { data } = await this.call(() =>
        this.http.post(this.accountPath(`/conversations/${chatwootConversationId}/messages`), form, {
          headers: form.getHeaders(),
          timeout: SEND_TIMEOUT_MS,
          maxBodyLength: SEND_MAX_BODY_LENGTH,
          maxContentLength: SEND_MAX_BODY_LENGTH,
        }),
      );
      return toMessageDto(data);
    }

    // messaging-inbox-notes (NOTE-4) — same additive rule as the multipart path above:
    // `private` only enters the JSON body when explicitly `true`.
    const body: Record<string, unknown> = { content, message_type: 'outgoing' };
    if (options?.private) body['private'] = true;
    const { data } = await this.call(() =>
      this.http.post(this.accountPath(`/conversations/${chatwootConversationId}/messages`), body),
    );
    return toMessageDto(data);
  }

  async searchContact(query: string): Promise<{ id: number; name: string | null; phone: string | null }[]> {
    return this.call(() => this.searchContactRaw(query));
  }

  /**
   * chatwoot-new-contact-404 (fix wave FW3a) — misma llamada que `searchContact`, pero SIN pasar
   * por `this.call`: `ensureContactInbox` necesita inspeccionar `err.response.status` (vía
   * `httpStatusOf`) para el mensaje diagnóstico (CHW-7), y `this.call` lo pierde al envolver en
   * `ChatwootUnavailableError` (mismo motivo por el que `postConversation` tampoco usa `this.call`).
   */
  private async searchContactRaw(
    query: string,
  ): Promise<{ id: number; name: string | null; phone: string | null }[]> {
    const { data } = await this.http.get(this.accountPath('/contacts/search'), { params: { q: query } });
    return extractRows(data).map(toContactDto);
  }

  async registerWebhook(url: string, secret: string): Promise<void> {
    await this.call(() =>
      this.http.post(this.accountPath('/webhooks'), {
        url,
        // chatwoot-hub-sendpath (design D2.c/D6) — 'message_updated' agregado para que
        // `content_attributes.external_error` (falla async de un template) llegue a
        // nuestro webhook (`ReceiveChatwootWebhook.handleMessageUpdated`, Batch 5).
        subscriptions: [
          'message_created',
          'conversation_created',
          'conversation_status_changed',
          'message_updated',
        ],
        secret,
      }),
    );
  }

  /**
   * chatwoot-hub-sendpath (design D2.a, CHW-1) — envía un template WhatsApp sobre una
   * conversación YA EXISTENTE (path del hilo). Reusa `accountPath`/`this.call`/
   * `toMessageDto` — cero código de manejo de error nuevo (mismo criterio único CHW-7).
   * `processedParams` mapea 1:1 sin transformación a `processed_params` (verificado en
   * vivo, exploración §5).
   */
  async sendTemplateMessage(
    chatwootConversationId: number,
    params: { name: string; language: string; processedParams: Record<string, string>; content: string },
  ): Promise<{ chatwootMessageId: number; content: string }> {
    const body = {
      content: params.content,
      message_type: 'outgoing',
      template_params: {
        name: params.name,
        language: params.language,
        processed_params: params.processedParams,
      },
    };
    const { data } = await this.call(() =>
      this.http.post(this.accountPath(`/conversations/${chatwootConversationId}/messages`), body),
    );
    const message = toMessageDto(data);
    return { chatwootMessageId: message.id, content: message.content };
  }

  /**
   * chatwoot-hub-sendpath (design D2.b, CHW-2) — creación de contacto+conversación+
   * primer mensaje (path bulk). Intenta PRIMERO `POST /conversations` con el
   * `source_id` derivado (`whatsapp:+E164`) — UNA sola llamada cuando el
   * `ContactInbox` ya existe (happy path, cero regresión). chatwoot-new-contact-404
   * (verificado en vivo y contra el fuente upstream) CORRIGE la premisa previa de
   * este docblock: Chatwoot NO hace find-or-create acá — su `before_action
   * :contact_inbox` hace un FIND por `(source_id, inbox_id)` y responde 404 cuando
   * no existe. Sólo ante ESE 404 el adapter asegura el contacto/`ContactInbox`
   * (`ensureContactInbox`) y reintenta `POST /conversations` EXACTAMENTE una vez con
   * el `source_id` leído de la respuesta de Chatwoot (nunca re-derivado, CHW-2). Un
   * segundo 404 en el reintento (o cualquier otra falla) se propaga como error
   * tipado — NUNCA un loop. `chatwootMessageId` se extrae del último mensaje de la
   * respuesta (intento síncrono, D2.b riesgo #3): si Chatwoot no lo expusiera de
   * forma fiable, el eco `message_created` del webhook igual pobla el mirror —
   * degradación aceptada, sin código adicional en este batch.
   */
  async createConversationWithTemplate(params: {
    phoneE164: string;
    name?: string | null;
    templateName: string;
    language: string;
    processedParams: Record<string, string>;
    content: string;
  }): Promise<{ chatwootConversationId: number; chatwootMessageId: number | null }> {
    // F11 (fix wave, quirúrgico) — normalización defensiva del teléfono: Chatwoot resuelve el
    // find/create por `source_id` EXACTO, así que un `whatsapp:` duplicado o espacios embebidos
    // NO matchearían el contacto (crearían uno nuevo / romperían la resolución). Strippeamos ambos.
    const normalizedPhone = params.phoneE164.replace(/\s+/g, '').replace(/^whatsapp:/i, '');
    const derivedSourceId = `whatsapp:${normalizedPhone}`;

    let raw: RawChatwootConversationCreate;
    try {
      raw = await this.postConversation(derivedSourceId, params);
    } catch (err) {
      // chatwoot-new-contact-404 (CHW-2) — el ensure SÓLO corre ante un 404 exacto en
      // ESTE primer intento; cualquier otro status/red-timeout se propaga tal cual
      // como error tipado del paso conversación (CHW-7), sin ensure de por medio.
      if (httpStatusOf(err) !== 404) {
        throw chatwootStepError('crear la conversación (POST /conversations)', err);
      }
      const sourceId = await this.ensureContactInbox(normalizedPhone, params.name);
      try {
        raw = await this.postConversation(sourceId, params);
      } catch (retryErr) {
        // chatwoot-new-contact-404 — el reintento es ÚNICO: cualquier falla acá
        // (incluido otro 404) se reporta tal cual, NUNCA un segundo ensure/loop.
        throw chatwootStepError('crear la conversación (POST /conversations)', retryErr);
      }
    }

    const lastMessage =
      raw.messages && raw.messages.length > 0 ? toMessageDto(raw.messages[raw.messages.length - 1]) : null;
    return {
      chatwootConversationId: raw.id,
      // F6 (fix wave) — `?? null`, NUNCA `NaN`: si el create no expone el message id (messages
      // vacío/ausente, o sin `id`), Prisma Int rechazaría NaN y el in-memory divergiría
      // (NaN!==NaN). Con null, la proyección saltea el mensaje pero preserva el link; el eco repone.
      chatwootMessageId: lastMessage != null && typeof lastMessage.id === 'number' ? lastMessage.id : null,
    };
  }

  /**
   * chatwoot-new-contact-404 — arma y postea el body de `POST /conversations`,
   * compartido por el intento inicial y el reintento único de
   * `createConversationWithTemplate` (2.9 REFACTOR, evita duplicar el armado del
   * body entre ambos). Deliberadamente SIN `this.call`: el caller necesita
   * inspeccionar `err.response.status` (vía `httpStatusOf`) ANTES de mapear a
   * `ChatwootUnavailableError`, algo que `this.call` no permite (traga el status).
   */
  private async postConversation(
    sourceId: string,
    params: { templateName: string; language: string; processedParams: Record<string, string>; content: string },
  ): Promise<RawChatwootConversationCreate> {
    const body = {
      inbox_id: this.inboxId,
      source_id: sourceId,
      message: {
        content: params.content,
        // F11 (fix wave) — message_type:'outgoing' (simetría con `sendTemplateMessage`): el eco
        // `message_created` cae como direction:'outbound' normal, reusable por upsertByChatwootMessageId.
        message_type: 'outgoing',
        template_params: {
          name: params.templateName,
          language: params.language,
          processed_params: params.processedParams,
        },
      },
    };
    const { data } = await this.http.post(this.accountPath('/conversations'), body);
    return data as RawChatwootConversationCreate;
  }

  /**
   * chatwoot-new-contact-404 (CHW-2) — asegura que el teléfono tenga un `Contact` +
   * `ContactInbox` en este inbox y devuelve el `source_id` CANÓNICO que Chatwoot le
   * asoció (leído de la respuesta — nunca re-derivado, ver design §Architecture
   * Decisions sobre la migración a `Channel::Whatsapp`).
   *
   * 1. `POST /contacts {inbox_id, phone_number, name?}` — una sola llamada crea
   *    Contact + ContactInbox en la MISMA transacción (verificado contra el fuente
   *    upstream, exploración §3). `name` sólo se envía si NO está vacío (puede ser
   *    `''` para recipients CSV, `SendCampaign.ts:205-212`).
   * 2. `422` (`Phone number has already been taken`) → el Contact ya existe: se
   *    resuelve por `GET /contacts/search?q=<dígitos>` (match por dígitos del
   *    teléfono, el ILIKE de Chatwoot no normaliza `+`) y se vincula el
   *    `ContactInbox` con `POST /contacts/:id/contact_inboxes` — NUNCA se crea un
   *    segundo `Contact`.
   * 3. Cualquier otra falla en cualquiera de los 3 pasos → `chatwootStepError` con el
   *    paso exacto que falló (CHW-7).
   */
  private async ensureContactInbox(normalizedPhone: string, name?: string | null): Promise<string> {
    // FW6 (fix wave, LOW) — trim + tope de 255 chars antes de mandarlo a Chatwoot; se omite el
    // campo si queda vacío TRAS el trim (no sólo si ya venía `''` exacto, ej. recipients CSV con
    // sólo espacios).
    const contactBody: Record<string, unknown> = { inbox_id: this.inboxId, phone_number: normalizedPhone };
    const trimmedName = name?.trim();
    if (trimmedName) contactBody.name = trimmedName.length > 255 ? trimmedName.slice(0, 255) : trimmedName;

    try {
      const { data } = await this.http.post(this.accountPath('/contacts'), contactBody);
      return extractContactInboxSourceId(data, normalizedPhone, this.inboxId, 'POST /contacts');
    } catch (err) {
      // FW2 (fix wave, MEDIUM) — sólo el 422 que Chatwoot marca como "teléfono duplicado" dispara
      // la resolución por búsqueda; cualquier OTRO 422 (validación distinta) se propaga tal cual.
      if (httpStatusOf(err) !== 422 || !isDuplicatePhoneConflict(err)) {
        throw chatwootStepError('crear el contacto (POST /contacts)', err);
      }
    }

    // 422 (teléfono duplicado) — el Contact ya existe en la cuenta; resolverlo y vincular el ContactInbox.
    const digits = normalizedPhone.replace(/\D/g, '');
    let matches: { id: number; name: string | null; phone: string | null }[];
    try {
      // FW3a (fix wave, MEDIUM) — `searchContactRaw`, NO `this.searchContact` (ese pasa por
      // `this.call`, que pierde `err.response.status` antes de que `chatwootStepError` lo lea).
      matches = await this.searchContactRaw(digits);
    } catch (err) {
      throw chatwootStepError('buscar el contacto (GET /contacts/search)', err);
    }
    const contact = matches.find((m) => m.phone != null && m.phone.replace(/\D/g, '') === digits);
    if (!contact) {
      // FW3b (fix wave, MEDIUM) — 0 coincidencias NO es un fallo HTTP (el GET respondió 200): un
      // mensaje propio, nunca el "— sin respuesta" de `chatwootStepError` (reservado a red/timeout).
      throw new ChatwootUnavailableError(
        `Chatwoot: buscar el contacto (GET /contacts/search): sin coincidencias para ${normalizedPhone}`,
      );
    }

    try {
      // FW1 (fix wave, MEDIUM-HIGH) — `source_id` YA NO se manda en este body: el
      // `ContactInboxBuilder` de Chatwoot lo genera según el canal cuando está ausente (misma
      // razón que motivó "leer, nunca re-derivar" en el design de este change, extendida acá a NO
      // forzar tampoco el formato en el REQUEST — forzarlo podía pisar un canal Cloud API con el
      // formato viejo de Twilio). El `source_id` real se toma SIEMPRE de la respuesta.
      const { data } = await this.http.post(this.accountPath(`/contacts/${contact.id}/contact_inboxes`), {
        inbox_id: this.inboxId,
      });
      return extractContactInboxSourceId(
        data,
        normalizedPhone,
        this.inboxId,
        'POST /contacts/:id/contact_inboxes',
      );
    } catch (err) {
      throw chatwootStepError('vincular el contacto al inbox (POST /contacts/:id/contact_inboxes)', err);
    }
  }

  /**
   * messaging-inbox-productivity (F1.5 fase C, STATUS-1) — same `toggle_status`
   * endpoint the Chatwoot UI itself uses (Application API v1). Same
   * wrapped-in-`this.call` convention as `sendMessage`/`registerWebhook` — ANY
   * failure (network/timeout/4xx/5xx) maps to `ChatwootUnavailableError`.
   */
  async setStatus(
    chatwootConversationId: number,
    status: 'open' | 'resolved' | 'pending' | 'snoozed',
    snoozedUntil?: string | null,
  ): Promise<void> {
    // conversation-snooze (Ola 6c) — Chatwoot espera `snoozed_until` en EPOCH SEGUNDOS (mismo
    // campo que usa su propia UI). Sólo se envía para status='snoozed' (ignorado en los demás).
    const body: Record<string, unknown> = { status };
    if (status === 'snoozed' && snoozedUntil) {
      body['snoozed_until'] = Math.floor(new Date(snoozedUntil).getTime() / 1000);
    }
    await this.call(() =>
      this.http.post(this.accountPath(`/conversations/${chatwootConversationId}/toggle_status`), body),
    );
  }

  /**
   * messaging-inbox-v2-media (Tanda 1 · MEDIA-2) — downloads a Chatwoot attachment
   * binary by following its `sourceUrl` (`data_url`, a stable 301 redirect). Uses a
   * BARE `axios.get` (NOT `this.http`, which carries the `api_access_token` default
   * header) so no auth header is ever sent to this request or to whatever host the
   * redirect lands on — verified live that the signed redirect needs none. Buffered
   * (not streamed): Tanda 1's decision is a serialized-download tradeoff (the
   * scheduler's `DistributedLock`/`inFlight` already caps concurrency to one).
   */
  async downloadAttachment(
    url: string,
    options?: RawGetOptions,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    return this.call(async () => {
      const response = await this.rawGet(url, options);
      const contentType =
        typeof response.headers?.['content-type'] === 'string'
          ? (response.headers['content-type'] as string)
          : 'application/octet-stream';
      return { buffer: Buffer.from(response.data), contentType };
    });
  }

  /**
   * campaign-chatwoot-label (design D1.b/D2, CLBL-1) — catálogo REAL de labels de
   * la cuenta. Reusa `accountPath`/`this.call`/`extractRows` — cero infra nueva de
   * error (mismo criterio único del resto del port).
   */
  async listAccountLabels(): Promise<ChatwootLabelDto[]> {
    const { data } = await this.call(() => this.http.get(this.accountPath('/labels')));
    return extractRows(data).map(toLabelDto);
  }

  /**
   * campaign-chatwoot-label (design D1.b/D2, CLBL-2) — crea la ficha COMPLETA del
   * label en el catálogo. La respuesta puede venir envuelta (`{payload:{...}}`) o
   * plana (`{...}`) según la versión del jbuilder — `data.payload ?? data` cubre
   * ambas sin asumir una sola forma.
   */
  async createAccountLabel(params: { title: string; color: string }): Promise<ChatwootLabelDto> {
    const { data } = await this.call(() =>
      this.http.post(this.accountPath('/labels'), { title: params.title, color: params.color }),
    );
    return toLabelDto(data.payload ?? data);
  }

  /**
   * campaign-chatwoot-label (design D2, CLBL-3/CLBL-4/CLBL-5) — GET-unión-POST
   * idempotente DENTRO del adapter: Chatwoot REEMPLAZA el set completo de tags en
   * el POST (`Labelable#update_labels`, no es aditivo) — por eso el adapter lee
   * los títulos actuales, arma la UNIÓN (dedup, order-stable) y postea el set
   * COMPLETO. Así JAMÁS pisa labels puestos a mano por un agente ni el label de
   * otra campaña previa sobre la misma conversación. La unión de un set consigo
   * mismo es un no-op → reintentos/re-aplicaciones idempotentes.
   */
  async addConversationLabels(chatwootConversationId: number, labels: string[]): Promise<void> {
    await this.call(async () => {
      const cur = await this.http.get(this.accountPath(`/conversations/${chatwootConversationId}/labels`));
      // fix wave (F2 [LOW hardening]) — `extractRowsStrict`, NO el `extractRows` laxo
      // compartido: acá un shape no reconocido NO puede degradar a `[]` silencioso
      // (ver comentario de la función).
      const existing = extractRowsStrict(cur.data).filter((t): t is string => typeof t === 'string');
      const union = Array.from(new Set([...existing, ...labels]));
      await this.http.post(this.accountPath(`/conversations/${chatwootConversationId}/labels`), {
        labels: union,
      });
    });
  }

  /**
   * ai-assistant-cobranzas (4.10 / D10 / ACT-4) — desasigna en Chatwoot.
   *
   * `assignee_id: 0` (el cero, no `null` ni el campo ausente) es la forma en que la API de
   * Chatwoot expresa "sin asignar" en `/assignments`: mandar `null` deja la asignación como
   * está, que sería un no-op silencioso — la peor variante posible acá, porque el motor
   * reportaría "desasignada" sobre una conversación que el agente sigue viendo suya.
   */
  async unassignConversation(chatwootConversationId: number): Promise<void> {
    await this.call(() =>
      this.http.post(this.accountPath(`/conversations/${chatwootConversationId}/assignments`), {
        assignee_id: 0,
      }),
    );
  }
}

/**
 * Los distintos endpoints de Chatwoot envuelven el array en formas distintas:
 * `{ data: { payload: [...] } }` (listado de conversaciones), `{ payload: [...] }`
 * (mensajes/búsqueda de contactos), o un array plano. Best-effort defensivo: la
 * primera forma reconocida gana; si ninguna aplica, devuelve `[]` (nunca truena).
 */
function extractRows(data: unknown): unknown[] {
  const asRecord = data as Record<string, unknown> | null | undefined;
  const nested = asRecord?.data as Record<string, unknown> | undefined;
  if (nested && Array.isArray(nested.payload)) return nested.payload as unknown[];
  if (asRecord && Array.isArray(asRecord.payload)) return asRecord.payload as unknown[];
  return Array.isArray(data) ? (data as unknown[]) : [];
}

/**
 * campaign-chatwoot-label (fix wave, F2 [LOW hardening]) — variante ESTRICTA de
 * `extractRows`, usada SOLO por `addConversationLabels` (el GET-unión-POST/RMW,
 * D2). Los demás consumidores de `extractRows` (`listConversations`,
 * `listMessages`, `searchContact`, `listAccountLabels`) son READ-ONLY puro: ahí
 * un shape inesperado degradando a `[]` es best-effort aceptable, comportamiento
 * PREEXISTENTE e intacto (ver test "payload ausente/no-array → []").
 *
 * El RMW es distinto: un parse-miss silencioso acá es INDISTINGUIBLE de "la
 * conversación no tiene labels", y el POST subsiguiente postearía el set
 * COMPLETO con solo el delta nuevo — PISANDO cualquier label manual (de un
 * agente) o de una campaña previa sobre la misma conversación. Por eso, un
 * shape que NO matchea ninguno de los 3 conocidos (`{payload:[...]}`,
 * `{data:{payload:[...]}}`, array plano) Y que NO es un objeto vacío legítimo
 * (`{}`, `null`, `undefined` — el molde defensivo pre-existente) debe abortar
 * el RMW entero: el `throw` de acá es capturado por `this.call` (que envuelve
 * TODA la callback de `addConversationLabels`) y re-mapeado a
 * `ChatwootUnavailableError` — mismo criterio de resultado único del port.
 * `{payload: []}` SIGUE siendo un caso vacío VÁLIDO (matchea el shape conocido
 * arriba, con array vacío) — no confundir con el "objeto sin ninguna clave".
 */
function extractRowsStrict(data: unknown): unknown[] {
  const asRecord = data as Record<string, unknown> | null | undefined;
  const nested = asRecord?.data as Record<string, unknown> | undefined;
  if (nested && Array.isArray(nested.payload)) return nested.payload as unknown[];
  if (asRecord && Array.isArray(asRecord.payload)) return asRecord.payload as unknown[];
  if (Array.isArray(data)) return data as unknown[];
  if (asRecord == null || Object.keys(asRecord).length === 0) return [];
  throw new Error(
    'Chatwoot: shape de respuesta no reconocido para labels de conversación (esperado {payload:[...]}/{data:{payload:[...]}}/array)',
  );
}

/** epoch seconds (convención wire de Chatwoot) → ISO 8601, o null si ausente. */
function toIsoOrNull(epochSeconds: unknown): string | null {
  return typeof epochSeconds === 'number' ? new Date(epochSeconds * 1000).toISOString() : null;
}

/**
 * H3/§Open Questions — epoch seconds → ISO 8601, o `undefined` si la CLAVE está
 * ausente/no-numérica en el wire. A diferencia de `toIsoOrNull`, NUNCA coacciona
 * ausencia a `null`: `GetConversation.syncFromChatwoot` reenvía este valor directo
 * al upsert del mirror, y `undefined` = campo intacto (no tocar) mientras que
 * `null` = valor real a escribir. Coaccionar ausencia a `null` acá pisaría con
 * null el `lastMessageAt` de una conversación cuyo GET simplemente no trajo el
 * campo (la conversación caía al fondo del inbox).
 */
function toIsoOrUndefined(epochSeconds: unknown): string | undefined {
  return typeof epochSeconds === 'number' ? new Date(epochSeconds * 1000).toISOString() : undefined;
}

interface RawChatwootConversation {
  id: number;
  status?: string;
  can_reply?: boolean;
  last_activity_at?: number | null;
  meta?: { sender?: { name?: string | null; phone_number?: string | null } };
}

function toConversationDto(raw: unknown): ChatwootConversationDto {
  const r = raw as RawChatwootConversation;
  return {
    id: r.id,
    // H3 — NO `?? null`: una clave ausente en el JSON (r.meta/r.meta.sender/.name
    // undefined vía optional chaining) debe seguir siendo `undefined`, distinto de
    // un `null` explícito de Chatwoot (un valor real y conocido: "sin nombre").
    contactName: r.meta?.sender?.name,
    contactPhone: r.meta?.sender?.phone_number,
    // Residuo #3 — NO `?? 'open'`/`?? false`: igual que arriba, una clave ausente debe
    // seguir siendo `undefined` para que `GetConversation.syncFromChatwoot` reenvíe
    // eso tal cual al upsert (undefined = no tocar), en vez de pisar el mirror con un
    // default que Chatwoot nunca mandó.
    status: r.status,
    canReply: r.can_reply,
    lastActivityAt: toIsoOrUndefined(r.last_activity_at),
  };
}

/** H1 — acepta el enum numérico de la GET API (0/1/2/3) Y el STRING del webhook real
 * ("incoming"/"outgoing"/"activity"/"template"), mismo mapeo que
 * `ReceiveChatwootWebhook.mapMessageTypeToDirection` (duplicado deliberado: distinta
 * capa, misma regla — infra no debe importar del use case). */
function mapMessageTypeToDirection(messageType: number | string | undefined): 'inbound' | 'outbound' | null {
  if (messageType === 0 || messageType === 'incoming') return 'inbound';
  if (messageType === 1 || messageType === 'outgoing') return 'outbound';
  return null; // 2/'activity', 3/'template', o desconocido/ausente
}

/**
 * messaging-inbox-v2-media (Tanda 1 · MEDIA-1 fetch-on-open parity) — same shape as
 * `RawChatwootAttachment` in `ReceiveChatwootWebhook.ts` (deliberate duplicate: distinct
 * layer, same wire rule — infra must not import from the application use case).
 */
interface RawChatwootMessageAttachment {
  id: number;
  file_type: string;
  content_type?: string;
  file_size?: number;
  width?: number;
  height?: number;
  data_url?: string;
  thumb_url?: string;
}

function toAttachmentDto(raw: RawChatwootMessageAttachment): ChatwootMessageAttachmentDto {
  return {
    id: raw.id,
    fileType: raw.file_type,
    contentType: raw.content_type ?? 'application/octet-stream',
    filename: null,
    sizeBytes: raw.file_size ?? null,
    width: raw.width ?? null,
    height: raw.height ?? null,
    sourceUrl: raw.data_url ?? '',
    thumbSourceUrl: raw.file_type === 'image' && raw.thumb_url ? raw.thumb_url : null,
  };
}

interface RawChatwootMessage {
  id: number;
  message_type?: number | string;
  content?: string | null;
  sender?: { name?: string | null };
  created_at?: number | null;
  /** H2 residual — internal agent note, same wire field as the webhook's `payload.private`. */
  private?: boolean;
  /** MEDIA-1 — same top-level shape as the webhook's `attachments[]` (Chatwoot's GET
   * .../messages response nests attachments identically, verified against source). */
  attachments?: RawChatwootMessageAttachment[];
}

function toMessageDto(raw: unknown): ChatwootMessageDto {
  const r = raw as RawChatwootMessage;
  return {
    id: r.id,
    direction: mapMessageTypeToDirection(r.message_type),
    content: r.content ?? '',
    senderName: r.sender?.name ?? null,
    // createdAt es requerido (no-nullable) en el DTO — fallback defensivo a "ahora" si
    // Chatwoot no lo trae, nunca truena el mapper.
    createdAt: toIsoOrNull(r.created_at) ?? new Date().toISOString(),
    // H2 residual — expuesto SOLO cuando es realmente `true` (mismo idioma H3 que
    // contactName/contactPhone: `undefined` = "no aplica/no vino", nunca un `false`
    // ruidoso) para que GetConversation.syncFromChatwoot lo filtre igual que el
    // webhook filtra `payload.private` (nunca persistir una nota).
    private: r.private === true ? true : undefined,
    attachments: r.attachments && r.attachments.length > 0 ? r.attachments.map(toAttachmentDto) : undefined,
  };
}

/**
 * chatwoot-hub-sendpath (design D2.b) — shape de la respuesta de
 * `POST /conversations` (find-or-create atómico). `messages` trae el primer mensaje
 * creado en la MISMA transacción (Chatwoot expone el recurso Conversation con sus
 * mensajes recientes anidados) — de acá se extrae el `chatwootMessageId` (intento
 * síncrono, ver comentario de `createConversationWithTemplate`).
 */
interface RawChatwootConversationCreate {
  id: number;
  messages?: RawChatwootMessage[];
}

interface RawChatwootContact {
  id: number;
  name?: string | null;
  phone_number?: string | null;
}

function toContactDto(raw: unknown): { id: number; name: string | null; phone: string | null } {
  const r = raw as RawChatwootContact;
  return { id: r.id, name: r.name ?? null, phone: r.phone_number ?? null };
}

/**
 * chatwoot-new-contact-404 (design §Interfaces/Contracts) — lee el `source_id`
 * CANÓNICO que Chatwoot asoció al `ContactInbox`, de la respuesta de `POST
 * /contacts` (create.json.jbuilder: bloque `contact_inbox: {inbox, source_id}`,
 * a veces envuelto en `{payload: {...}}`) o de `POST /contacts/:id/contact_inboxes`
 * (puede exponer `source_id` en el nivel superior del recurso ContactInbox). Nunca
 * re-deriva el formato localmente (design: inmune a una migración de canal
 * `Channel::TwilioSms` → `Channel::Whatsapp`, que cambia el shape del `source_id`).
 * El `whatsapp:${normalizedPhone}` derivado es sólo el ÚLTIMO recurso defensivo si
 * ninguna forma conocida trae el campo.
 */
function extractContactInboxSourceId(
  raw: unknown,
  normalizedPhone: string,
  inboxId: string,
  stepLabel: string,
): string {
  const asRecord = raw as Record<string, unknown> | null | undefined;
  const payload = (asRecord?.['payload'] as Record<string, unknown> | undefined) ?? asRecord ?? undefined;
  const contactInbox = payload?.['contact_inbox'] as { source_id?: unknown } | undefined;
  const contactInboxes = payload?.['contact_inboxes'] as
    | Array<{ source_id?: unknown; inbox?: { id?: unknown }; inbox_id?: unknown }>
    | undefined;

  // fix wave FW4 (LOW-MEDIUM) — con MÁS de un inbox en `contact_inboxes[]`, el `source_id`
  // correcto es el de ESTE inbox (`inboxId`), nunca "el primero del array" a ciegas. Si ninguno
  // matchea, cae al primero como fallback defensivo pero deja constancia con un warning.
  let fromInboxesArray: unknown;
  if (Array.isArray(contactInboxes) && contactInboxes.length > 0) {
    const match = contactInboxes.find((ci) => String(ci.inbox?.id ?? ci.inbox_id ?? '') === String(inboxId));
    if (!match) {
      console.warn(
        `Chatwoot: ${stepLabel} — contact_inboxes sin match para inboxId=${inboxId}, usando el primero como fallback`,
      );
    }
    fromInboxesArray = (match ?? contactInboxes[0])?.source_id;
  }

  const candidates: unknown[] = [contactInbox?.source_id, fromInboxesArray, payload?.['source_id']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  // fix wave FW5 (LOW) — ningún shape conocido trajo el campo: se cae al derivado local como
  // ÚLTIMO recurso, pero nunca en silencio — el warning deja rastro de qué shape llegó realmente.
  console.warn(
    `Chatwoot: ${stepLabel} — shape de respuesta no reconocido para contact_inbox, usando fallback derivado whatsapp:${normalizedPhone}. keys=${asRecord ? Object.keys(asRecord).join(',') : 'null'}`,
  );
  return `whatsapp:${normalizedPhone}`;
}

/**
 * campaign-chatwoot-label (design D2) — molde `toConversationDto`/`toContactDto`:
 * mapeo curado del payload jbuilder del catálogo de labels. Descarta cualquier
 * campo extra (ej. `id`, `description`, `show_on_sidebar`) — el DTO de dominio es
 * `{title,color}` (D1.a).
 */
interface RawChatwootLabel {
  title: string;
  color: string;
}

function toLabelDto(raw: unknown): ChatwootLabelDto {
  const r = raw as RawChatwootLabel;
  return { title: r.title, color: r.color };
}
