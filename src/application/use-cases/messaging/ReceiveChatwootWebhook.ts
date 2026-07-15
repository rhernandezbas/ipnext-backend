import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ChatMessageRepository } from '@domain/ports/ChatMessageRepository';
import type { WebhookDeliveryRepository } from '@domain/ports/WebhookDeliveryRepository';
import type { ChatMessageAttachmentRepository } from '@domain/ports/ChatMessageAttachmentRepository';
import type { ChatMediaDownloadTrigger } from '@domain/ports/ChatMediaDownloadTrigger';
import type { CampaignSegmentSource, OptOutRegistry } from '@domain/ports/CustomerRepository';
import { toWhatsAppE164 } from './toWhatsAppE164';
import { deriveConversationPreview } from './conversationPreview';

/** OPT-2 — keywords que disparan el opt-out (case-insensitive, trim-tolerant, match EXACTO). */
const OPT_OUT_KEYWORDS = new Set(['BAJA', 'STOP']);

/**
 * messaging-inbox-v2-media (F1.5 fase A, Tanda 1 · MEDIA-1) — a single Chatwoot
 * attachment as it arrives on the webhook's TOP-LEVEL `attachments[]` array
 * (verified against Chatwoot v4.13.0 source, `Attachment#push_event_data`/
 * `Message#webhook_data`: the local `data` hash IS the webhook's JSON root, so
 * `attachments` sits alongside `content`/`conversation`/`sender` — same level,
 * NOT nested under a `data` key). `file_type` arrives as a STRING enum.
 */
export interface RawChatwootAttachment {
  id: number;
  message_id?: number;
  /** 'image' | 'audio' | 'video' | 'file' | 'location' | 'contact' | 'fallback' | 'embed'. */
  file_type: string;
  account_id?: number;
  extension?: string;
  content_type?: string;
  /** 301-redirect, stable, verified live to need no `api_access_token`. */
  data_url?: string;
  /** Only populated for `file_type==='image'`; `''` for the rest. */
  thumb_url?: string;
  file_size?: number;
  width?: number;
  height?: number;
}

/** MEDIA-1 — only these carry a downloadable binary; the rest never get a row. */
const BINARY_FILE_TYPES = new Set(['image', 'audio', 'video', 'file']);

/**
 * Chatwoot webhook payload — DOMAIN shape as received by this use case, AFTER the HMAC
 * middleware (B5) has verified the signature/timestamp and the route has JSON-parsed the
 * raw body. This use case never sees the raw bytes, only this parsed object.
 *
 * Field-path assumptions (VERIFIED against a live `.37` `message_created` webhook — no
 * longer best-effort): the TOP-LEVEL `message_type` is a STRING
 * ("incoming"/"outgoing"/"activity"/"template"), NOT the numeric enum the GET API uses
 * (0/1/2/3, still seen via `HttpChatwootGateway`'s fetch-on-open) — `mapMessageTypeToDirection`
 * accepts BOTH forms (H1). `private` (bool) marks an internal agent note: never persisted,
 * never bumps the mirror's preview (H2/§6). Contact identity for a MESSAGE-level event
 * travels under `conversation.meta.sender.{name,phone_number}` (M1) — NOT top-level
 * `meta.sender`, which only applies to CONVERSATION-level events
 * (`conversation_created`/`conversation_status_changed`, handled separately below).
 * `conversation.can_reply` mirrors Chatwoot's 24h-window flag (M2). `sender.name`
 * (top-level, message-only) is the MESSAGE's own sender display name — NOT necessarily
 * the contact (could be the agent on an outbound message) — kept deliberately separate
 * from `conversation.meta.sender.name`. Conversation-level events carry the
 * conversation's own id as the top-level `id`; message-level events nest it under
 * `conversation.id`.
 */
export interface ChatwootWebhookPayload {
  event: string;
  id?: number;
  content?: string | null;
  message_type?: number | string;
  created_at?: string | number;
  status?: string;
  /** H2 — true for an internal agent note (never persisted, never bumps the preview). */
  private?: boolean;
  conversation?: {
    id: number;
    /** M2 — Chatwoot's live 24h-window flag, only present on message-level events. */
    can_reply?: boolean;
    /** M1 — the REAL wire path for contact identity on a message-level event. */
    meta?: { sender?: { name?: string | null; phone_number?: string | null } | null };
  };
  sender?: { name?: string | null } | null;
  /** Only meaningful on CONVERSATION-level events (`conversation_created`/`conversation_status_changed`). */
  meta?: { sender?: { name?: string | null; phone_number?: string | null } | null };
  /** MEDIA-1 — top-level, same nesting level as `content`/`conversation`/`sender` (see RawChatwootAttachment doc). */
  attachments?: RawChatwootAttachment[];
}

const WEBHOOK_SOURCE = 'chatwoot';

/** H1 — accepts Chatwoot's real webhook STRING enum and the GET API's numeric enum. */
function mapMessageTypeToDirection(messageType: number | string | undefined): 'inbound' | 'outbound' | null {
  if (messageType === 0 || messageType === 'incoming') return 'inbound';
  if (messageType === 1 || messageType === 'outgoing') return 'outbound';
  return null; // 2/'activity', 3/'template', or unknown/undefined — never persisted (§7)
}

function toIsoTimestamp(raw: string | number | undefined): string {
  if (raw === undefined) return new Date().toISOString();
  if (typeof raw === 'number') return new Date(raw * 1000).toISOString(); // Chatwoot epoch seconds
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/**
 * ReceiveChatwootWebhook (F1, design §4, HOOK-3/4/5) — processes an already
 * signature-verified Chatwoot webhook delivery.
 *
 * Dedup (HOOK-3/ROB-2) is PROCESS-THEN-RECORD: `hasSeen` is a read-only check done
 * FIRST (a seen delivery is acked without touching `Conversation`/`ChatMessage` nor
 * re-recording); the event is then processed; the delivery is marked seen via
 * `recordIfNew` ONLY AFTER the handler completes successfully. Recording BEFORE
 * processing (the old order) would burn the delivery id even when the handler
 * throws, silently discarding Chatwoot's retry — the one copy of that event that
 * would ever succeed is gone for good.
 *
 * Never throws on a malformed or unsubscribed event (HOOK-5) — degrades to a no-op
 * so the webhook route can always ack 200 without risking Chatwoot's retry storm.
 */
export class ReceiveChatwootWebhook {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: ChatMessageRepository,
    private readonly deliveryRepo: WebhookDeliveryRepository,
    /** messaging-inbox-v2-media (Tanda 1) — optional so existing 3-arg call sites keep compiling. */
    private readonly attachmentRepo?: ChatMessageAttachmentRepository,
    private readonly downloadTrigger?: ChatMediaDownloadTrigger,
    /**
     * messaging-bulk (F2, Batch 6, T6.5, OPT-2) — optional (existing 3/5-arg
     * call sites keep compiling, same criterion as `attachmentRepo`/
     * `downloadTrigger` above). Resuelve el `Client` por teléfono (tasks.md
     * contradicción #4: `listSegmentRecipients({statuses:[]})`, NUNCA
     * `listActiveContacts()` — ese excluiría late/blocked/baja, el público del
     * bulk) y registra el opt-out (OPT-1) cuando matchea.
     */
    private readonly optOutSource?: CampaignSegmentSource & OptOutRegistry,
  ) {}

  async execute(deliveryId: string, payload: ChatwootWebhookPayload): Promise<void> {
    const alreadySeen = await this.deliveryRepo.hasSeen(WEBHOOK_SOURCE, deliveryId);
    if (alreadySeen) return; // HOOK-3 — already processed, ack without reprocessing

    await this.process(payload); // may throw — delivery NOT recorded yet (ROB-2)

    await this.deliveryRepo.recordIfNew(WEBHOOK_SOURCE, deliveryId); // recorded ONLY after success
  }

  private async process(payload: ChatwootWebhookPayload): Promise<void> {
    switch (payload.event) {
      case 'message_created':
        return this.handleMessageCreated(payload);
      case 'conversation_created':
        return this.handleConversationCreated(payload);
      case 'conversation_status_changed':
        return this.handleConversationStatusChanged(payload);
      default:
        return; // HOOK-5 — unsubscribed event type, ignored without error
    }
  }

  private async handleMessageCreated(payload: ChatwootWebhookPayload): Promise<void> {
    const chatwootConversationId = payload.conversation?.id;
    if (chatwootConversationId === undefined) return; // malformed payload — no-op, never throws

    const createdAt = toIsoTimestamp(payload.created_at);
    const direction = mapMessageTypeToDirection(payload.message_type);
    const isPrivateNote = payload.private === true;
    // H2/§6 — an internal note or an activity/template system message is NOT
    // customer-facing: it must never bump the inbox preview/lastMessageAt.
    const bumpsPreview = direction !== null && !isPrivateNote;
    const sender = payload.conversation?.meta?.sender; // M1 — real wire path, not top-level meta.sender
    // messaging-inbox-polish (F1.5) — only the BINARY attachments (same set the mirror
    // actually rows) feed the WhatsApp-style media preview; location/contact/fallback/embed
    // never count, so a location-only message keeps the original (empty) fallback.
    const mediaFileTypes = (payload.attachments ?? [])
      .filter((a) => BINARY_FILE_TYPES.has(a.file_type))
      .map((a) => a.file_type);

    // messaging-bulk (F2, OPT-2) — solo mensajes INBOUND disparan la detección de
    // baja; corre ANTES del upsert de abajo (independiente de si el mensaje en sí
    // termina persistiéndose — ver el early-return de §7 más abajo).
    if (direction === 'inbound') {
      await this.maybeRegisterOptOut(payload.content, sender?.phone_number);
    }

    // messaging-bulk-inbox (F1, FASE 2) — reconciliación ANTES del upsert: si el
    // cliente responde una conversación que ARRANCÓ como bulk, la adoptamos (mismo id)
    // así el upsert de abajo cae sobre ELLA y NO crea un duplicado.
    await this.maybeAdoptBulkConversation(chatwootConversationId, sender?.phone_number);

    const conversation = await this.conversationRepo.upsertByChatwootId({
      chatwootConversationId,
      contactName: sender?.name,
      contactPhone: sender?.phone_number,
      canReply: payload.conversation?.can_reply, // M2 — keeps the mirror's canReply fresh
      lastMessageAt: bumpsPreview ? createdAt : undefined,
      lastMessagePreview: bumpsPreview ? deriveConversationPreview(payload.content, mediaFileTypes) : undefined,
    });

    // §7 — activity/template (direction===null) never persist. messaging-inbox-notes
    // (F1.5 fase D, NOTE-2) — private notes are NO LONGER discarded here: they persist
    // marked `isPrivate:true` below. `bumpsPreview` (above) is the ONLY guard that still
    // treats private specially — it must NEVER bump the inbox preview (NOTE-3).
    if (direction === null || payload.id === undefined) return;

    const message = await this.messageRepo.upsertByChatwootMessageId({
      conversationId: conversation.id,
      chatwootMessageId: payload.id,
      direction,
      content: payload.content ?? '',
      senderName: payload.sender?.name,
      chatwootCreatedAt: createdAt,
      isPrivate: isPrivateNote,
    });

    await this.captureAttachments(message.id, payload.attachments);
  }

  /**
   * messaging-bulk (F2, Batch 6, T6.5, OPT-2) — detecta las keywords
   * BAJA/STOP (case-insensitive, trim-tolerant, match EXACTO de keyword — no
   * substring: "quiero darme de baja" NO dispara, se evita el falso positivo;
   * afinar la detección de frases es mejora futura) en el contenido de un
   * mensaje INBOUND y, si matchea, resuelve el `Client` por teléfono y
   * registra su opt-out (OPT-1).
   *
   * tasks.md contradicción #4 — resuelve contra
   * `optOutSource.listSegmentRecipients({statuses:[]})` (el escape hatch
   * narrow de T6.3: universo COMPLETO, sin filtro de status ni de opt-out),
   * NUNCA `listActiveContacts()` — ese filtra `status:'active'` y excluiría
   * justo a los `late`/`blocked`/`baja` que son el público principal del
   * bulk (los que más responden "BAJA").
   *
   * ── fix wave 3 (FIX-9-v2): match por E164 canónico, no por `normalizePhone` ──
   * FIX-9 (wave 2) cambió el `suffixMatch` (últimos 8 dígitos → dos áreas
   * distintas colisionaban y AMBAS se daban de baja) por igualdad EXACTA de
   * `normalizePhone`. Pero `normalizePhone` es LOSSY: NO strippea el "15" móvil
   * embebido entre área y abonado, así que un `Client.phone = "011 15-2345-6789"`
   * normalizaba distinto que el webhook `+5491123456789` → el opt-out se IGNORABA
   * en silencio (regresión: opt-out ignorado = riesgo de baneo Meta, PEOR que el
   * falso-positivo cross-área original). Ahora el match es por
   * `toWhatsAppE164(webhookFrom) === toWhatsAppE164(client.phone)` (ambos
   * no-null): `toWhatsAppE164` (Wave 1) canonicaliza el "15" embebido y ancla en
   * el NSN de 10 dígitos, así que resuelve el falso-NEGATIVO del "15" Y mantiene
   * el fix del falso-positivo cross-área (áreas distintas → E164 distinto). Si
   * `toWhatsAppE164` da null de algún lado, ese candidato NO matchea (teléfono no
   * reconstruible con confianza). Si hay >1 exacto (el MISMO E164 en varios
   * `Client`, ej. co-titulares) se opta-out a TODOS — conservador y
   * compliance-safe: la de-dup de campaña colapsa ese número a UN recipient, así
   * que suprimir todas las fichas garantiza que NUNCA vuelva a recibir.
   *
   * ── fix wave 2 (FIX-10): fail-open real ─────────────────────────────────────
   * El docstring prometía "nunca lanza" pero `listSegmentRecipients`/
   * `registerOptOut` PODÍAN throw (hipo de DB) y el error subía por `execute`,
   * volando el webhook ANTES de espejar el mensaje (el "BAJA" se perdía y
   * Chatwoot reintentaba y re-explotaba). Ahora la resolución/registro va
   * envuelta en try/catch: se loguea y se sigue — el mensaje SIEMPRE se espeja.
   *
   * Fail-open, nunca lanza: sin `optOutSource` inyectado (call sites
   * existentes, 3/5-arg), sin keyword, o sin match de teléfono → no-op
   * silencioso (mismo criterio HOOK-4/5 — un contacto sin match no rompe el
   * resto del webhook).
   */
  private async maybeRegisterOptOut(
    content: string | null | undefined,
    phone: string | null | undefined,
  ): Promise<void> {
    if (!this.optOutSource) return;

    const trimmedUpper = (content ?? '').trim().toUpperCase();
    if (!OPT_OUT_KEYWORDS.has(trimmedUpper)) return;

    const fromE164 = toWhatsAppE164(phone);
    if (fromE164 === null) return; // teléfono del webhook no reconstruible → no-op

    try {
      const candidates = await this.optOutSource.listSegmentRecipients({ statuses: [] });
      // FIX-9-v2 — match por E164 CANÓNICO (no `normalizePhone`, que es lossy con
      // el "15" embebido). Un candidato cuyo teléfono no reconstruye E164 no matchea.
      const exactMatches = candidates.filter((c) => {
        const candidateE164 = toWhatsAppE164(c.phone);
        return candidateE164 !== null && candidateE164 === fromE164;
      });
      if (exactMatches.length === 0) {
        // eslint-disable-next-line no-console
        console.info('[messaging] opt-out keyword sin match EXACTO de teléfono (E164) — no-op', { fromE164 });
        return;
      }
      for (const match of exactMatches) {
        await this.optOutSource.registerOptOut(match.clientId);
      }
    } catch (err) {
      // FIX-10 — fail-open: el opt-out es best-effort; su fallo NUNCA debe
      // impedir que el mensaje se espeje (ni propagar → Chatwoot no reintenta).
      // eslint-disable-next-line no-console
      console.error('[messaging] registro de opt-out falló (fail-open, el webhook igual espeja el mensaje)', {
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  /**
   * MEDIA-1 — upserts one `ChatMessageAttachment` row (status `pending`) per
   * BINARY attachment (`image`/`audio`/`video`/`file`); `location`/`contact`/
   * `fallback`/`embed` never get a row (no downloadable binary). Fires
   * `downloadTrigger.requestDownload` per NEW/refreshed row, isolated in its
   * own try/catch (MEDIA-6/scenario 24): a synchronous throw from the trigger's
   * infra impl must NEVER abort the webhook's 200 response.
   */
  private async captureAttachments(messageId: string, attachments: RawChatwootAttachment[] | undefined): Promise<void> {
    if (!this.attachmentRepo || !attachments || attachments.length === 0) return;

    for (const raw of attachments) {
      if (!BINARY_FILE_TYPES.has(raw.file_type)) continue;

      const row = await this.attachmentRepo.upsertByChatwootAttachmentId({
        messageId,
        chatwootAttachmentId: raw.id,
        fileType: raw.file_type,
        contentType: raw.content_type ?? 'application/octet-stream',
        sizeBytes: raw.file_size ?? null,
        width: raw.width ?? null,
        height: raw.height ?? null,
        sourceUrl: raw.data_url ?? '',
        thumbSourceUrl: raw.file_type === 'image' && raw.thumb_url ? raw.thumb_url : null,
      });

      if (!this.downloadTrigger) continue;
      try {
        this.downloadTrigger.requestDownload(row.id);
      } catch (err) {
        // MEDIA-6 — isolated on purpose: a bug in the trigger's infra impl must
        // never take down the webhook's 200 ack. The ChatMediaDownloadScheduler
        // (MEDIA-3) is the safety net that eventually retries this row anyway.
        console.error('[messaging] ChatMediaDownloadTrigger.requestDownload threw (isolated, webhook still acks 200)', {
          attachmentId: row.id,
          error: err,
        });
      }
    }
  }

  private async handleConversationCreated(payload: ChatwootWebhookPayload): Promise<void> {
    const chatwootConversationId = payload.id;
    if (chatwootConversationId === undefined) return;

    // messaging-bulk-inbox (F1, FASE 2) — adopta una conversación bulk pendiente ANTES
    // del upsert, para que el upsert caiga sobre ella (mismo id) y no cree un duplicado.
    await this.maybeAdoptBulkConversation(chatwootConversationId, payload.meta?.sender?.phone_number);

    await this.conversationRepo.upsertByChatwootId({
      chatwootConversationId,
      contactName: payload.meta?.sender?.name,
      contactPhone: payload.meta?.sender?.phone_number,
      status: payload.status,
    });
  }

  /**
   * messaging-bulk-inbox (F1, FASE 2 — reconciliación AISLADA, mayor riesgo) —
   * cuando llega un evento de Chatwoot con teléfono, intenta ADOPTAR una conversación
   * `origin:'bulk'` sin `chatwootConversationId` y mismo teléfono normalizado,
   * conservando su `id` (el `recipient.conversationId` sigue válido, sin repoint). El
   * `adoptBulkConversation` del repo NUNCA toca una conversación Chatwoot existente ni
   * adopta si el `chatwootConversationId` ya está tomado (no duplica).
   *
   * Fail-open, nunca lanza (mismo criterio que `maybeRegisterOptOut`): sin teléfono
   * reconstruible o ante un hipo de DB → se loguea y se sigue (el webhook SIEMPRE
   * espeja el mensaje). El síntoma de un bug acá sería una conversación DUPLICADA,
   * por eso está bien testeada y AISLADA del write-path principal.
   *
   * Clave de lookup = `toWhatsAppE164` (E164 CANÓNICO), NO `normalizePhone`: ese es
   * LOSSY con el "15" móvil embebido → keyearía distinto que el bulk y NUNCA matchearía
   * (duplicado sistemático). Mismo criterio que el opt-out (FIX-9-v2).
   */
  private async maybeAdoptBulkConversation(
    chatwootConversationId: number,
    phone: string | null | undefined,
  ): Promise<void> {
    const phoneE164 = toWhatsAppE164(phone);
    if (phoneE164 === null) return; // teléfono ausente/no reconstruible → no hay clave de matcheo

    try {
      await this.conversationRepo.adoptBulkConversation(phoneE164, chatwootConversationId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[messaging] adopción Fase 2 de conversación bulk falló (fail-open, el webhook igual espeja)', {
        chatwootConversationId,
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  private async handleConversationStatusChanged(payload: ChatwootWebhookPayload): Promise<void> {
    const chatwootConversationId = payload.id;
    if (chatwootConversationId === undefined || payload.status === undefined) return;

    await this.conversationRepo.upsertByChatwootId({
      chatwootConversationId,
      status: payload.status,
    });
  }
}
