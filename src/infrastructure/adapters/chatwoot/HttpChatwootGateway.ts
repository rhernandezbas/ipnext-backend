import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import {
  ChatwootConversationDto,
  ChatwootGateway,
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
    const { data } = await this.call(() =>
      this.http.get(this.accountPath('/contacts/search'), { params: { q: query } }),
    );
    return extractRows(data).map(toContactDto);
  }

  async registerWebhook(url: string, secret: string): Promise<void> {
    await this.call(() =>
      this.http.post(this.accountPath('/webhooks'), {
        url,
        subscriptions: ['message_created', 'conversation_created', 'conversation_status_changed'],
        secret,
      }),
    );
  }

  /**
   * messaging-inbox-productivity (F1.5 fase C, STATUS-1) — same `toggle_status`
   * endpoint the Chatwoot UI itself uses (Application API v1). Same
   * wrapped-in-`this.call` convention as `sendMessage`/`registerWebhook` — ANY
   * failure (network/timeout/4xx/5xx) maps to `ChatwootUnavailableError`.
   */
  async setStatus(chatwootConversationId: number, status: 'open' | 'resolved' | 'pending'): Promise<void> {
    await this.call(() =>
      this.http.post(this.accountPath(`/conversations/${chatwootConversationId}/toggle_status`), { status }),
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

interface RawChatwootContact {
  id: number;
  name?: string | null;
  phone_number?: string | null;
}

function toContactDto(raw: unknown): { id: number; name: string | null; phone: string | null } {
  const r = raw as RawChatwootContact;
  return { id: r.id, name: r.name ?? null, phone: r.phone_number ?? null };
}
