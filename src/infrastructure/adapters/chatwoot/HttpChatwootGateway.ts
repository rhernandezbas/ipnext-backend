import axios, { AxiosInstance } from 'axios';
import { ChatwootConversationDto, ChatwootGateway, ChatwootMessageDto } from '@domain/ports/ChatwootGateway';
import { ChatwootUnavailableError } from '@domain/errors/messaging';

export interface HttpChatwootGatewayOptions {
  baseUrl: string;
  accountId: string;
  inboxId: string;
  apiToken: string;
  /** Inyectable para tests (AxiosInstance fake). En prod se crea internamente. */
  http?: AxiosInstance;
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

  constructor(opts: HttpChatwootGatewayOptions) {
    this.accountId = opts.accountId;
    this.inboxId = opts.inboxId;
    this.http =
      opts.http ??
      axios.create({
        baseURL: opts.baseUrl,
        headers: { api_access_token: opts.apiToken },
      });
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

  async sendMessage(chatwootConversationId: number, content: string): Promise<ChatwootMessageDto> {
    const { data } = await this.call(() =>
      this.http.post(this.accountPath(`/conversations/${chatwootConversationId}/messages`), {
        content,
        message_type: 'outgoing',
      }),
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

interface RawChatwootMessage {
  id: number;
  message_type?: number | string;
  content?: string | null;
  sender?: { name?: string | null };
  created_at?: number | null;
  /** H2 residual — internal agent note, same wire field as the webhook's `payload.private`. */
  private?: boolean;
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
