import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ChatMessageRepository } from '@domain/ports/ChatMessageRepository';
import type { ChatwootGateway, ChatwootMessageDto, OutboundAttachmentFile } from '@domain/ports/ChatwootGateway';
import type {
  ChatMessageAttachmentRepository,
  ChatMessageAttachmentRecord,
} from '@domain/ports/ChatMessageAttachmentRepository';
import type { ChatMediaDownloadTrigger } from '@domain/ports/ChatMediaDownloadTrigger';
import {
  ConversationNotFoundError,
  MessagingWindowExpiredError,
  ChatwootUnavailableError,
} from '@domain/errors/messaging';
// GOTCHA (spec-send.md/proposal-send.md, deliberate) — there is a HOMONYMOUS
// `UnsupportedAttachmentTypeError` in `domain/errors/taskAttachment.ts` (scheduling
// domain, task photos). These are TWO distinct classes with DIFFERENT error codes
// (`CHAT_ATTACHMENT_UNSUPPORTED_TYPE` here vs `UNSUPPORTED_ATTACHMENT_TYPE` there).
// This file MUST import from `chatAttachment.ts`, never from `taskAttachment.ts`.
import { AttachmentTooLargeError, UnsupportedAttachmentTypeError } from '@domain/errors/chatAttachment';
import { MAX_BYTES_BY_FILE_TYPE } from './DownloadChatMessageAttachment';
import { toChatMessageDto, type ChatMessageDto } from '@application/dto/messaging';
import { deriveConversationPreview } from './conversationPreview';

type OutboundFileType = 'image' | 'video' | 'audio' | 'file';

/** SEND-1 guard 3 — image/* video/* audio/* → their category, everything else → the
 * catch-all 'file'. The ONLY way to fail classification is an empty/absent contentType
 * (checked separately, BEFORE this runs) — see spec-send.md "Semántica exacta de 415". */
function deriveFileType(contentType: string): OutboundFileType {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'file';
}

function maxBytesFor(fileType: OutboundFileType): number {
  return MAX_BYTES_BY_FILE_TYPE[fileType] ?? MAX_BYTES_BY_FILE_TYPE['file']!;
}

interface ValidatedOutboundFile extends OutboundAttachmentFile {
  fileType: OutboundFileType;
}

/**
 * SendMessage (F1 SEND-1/2/3, extended Tanda 2 · SEND-1/4/5/7/8) — reply within the
 * 24h WhatsApp window, now with OPTIONAL attachments (aditivo, retrocompatible: sin
 * `files` el comportamiento es idéntico al F1 actual).
 *
 * `canReply` is read straight from the `Conversation` MIRROR — the cache last set by
 * `GetConversation`'s fetch-on-open or by a webhook upsert — and is NEVER recomputed
 * with local 24h math (design §4, decision confirmed by the user).
 *
 * Guard order (PINNED, spec-send.md SEND-1, cutting at the first failure):
 *   1. `conversationRepo.findById` → 404 `ConversationNotFoundError`.
 *   2. `!canReply` → 422 `MessagingWindowExpiredError`, WITHOUT calling Chatwoot NOR
 *      validating `files` (guard 2 always runs before guard 3).
 *   3. Validate the WHOLE `files` batch UPFRONT (fileType from contentType + size vs.
 *      `MAX_BYTES_BY_FILE_TYPE`) → 415/413. "All or nothing": if ANY file fails, NONE
 *      is sent (same criterion as `AttachPhotosToTask`). This is ONLY an outbound
 *      guard against sending garbage to Chatwoot — its result (`fileType` per file)
 *      is NEVER stored; see SEND-5 below for why.
 *   4. `gateway.sendMessage` → any failure (SEND-3, unchanged) → 503
 *      `ChatwootUnavailableError`; with `files`, NOTHING is persisted either.
 *
 * fix-be #1 (CRÍTICO, re-diseño) — Post-OK mirror (SEND-5) NO alinea POSICIONALMENTE
 * `sent.attachments[i]` con `files[i]` anymore. That alignment was a silent data
 * corruption bug: if Chatwoot DROPS an attachment (unsupported subtype) or REORDERS
 * the echoed array, `sentAttachment.id` would end up paired with the WRONG local
 * buffer under that id — permanently, since the row is keyed by
 * `chatwootAttachmentId`. Instead, EACH `sentAttachment` in Chatwoot's OWN response
 * is mirrored using CHATWOOT's OWN metadata (`id`/`fileType`/`contentType`/`filename`/
 * `sizeBytes`/`width`/`height`/`sourceUrl`/`thumbSourceUrl` — never `origin.buffer`/
 * `origin.contentType`), left `pending`, and `downloadTrigger.requestDownload` is
 * fired fire-and-forget — EXACTLY the same fetch-on-open/webhook capture pattern as
 * `ReceiveChatwootWebhook`/`GetConversation`. `DownloadChatMessageAttachment` (Tanda 1)
 * then downloads the binary straight from `sourceUrl` by id, so there is NEVER any
 * positional pairing, NEVER a local buffer written to storage from this use case.
 *
 * The ENTIRE per-attachment body (upsert INCLUDED) is wrapped in its own try/catch:
 * a Prisma failure while mirroring one attachment (or a synchronous throw from the
 * trigger's infra impl) is logged and the loop continues — it must NEVER abort
 * `execute()` nor change the HTTP status, because the WhatsApp message ALREADY went
 * out (SEND-8). A `sent.attachments.length !== files.length` mismatch (Chatwoot
 * dropped/added one) is also logged — never silently swallowed, but never fatal.
 */
export class SendMessage {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: ChatMessageRepository,
    private readonly gateway: ChatwootGateway,
    private readonly attachmentRepo: ChatMessageAttachmentRepository,
    /** messaging-inbox-v2-media (Tanda 1 pattern) — optional so existing 4-arg call
     * sites keep compiling; without it the mirror rows still get created `pending`,
     * they just never get auto-downloaded (the periodic scheduler still would). */
    private readonly downloadTrigger?: ChatMediaDownloadTrigger,
  ) {}

  async execute(
    conversationId: string,
    content: string,
    files: OutboundAttachmentFile[] = [],
  ): Promise<ChatMessageDto> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    if (!conversation.canReply) {
      throw new MessagingWindowExpiredError(conversationId);
    }

    // SEND-1 guard 3 — validate the WHOLE batch upfront, before touching Chatwoot.
    const validatedFiles: ValidatedOutboundFile[] = files.map((file) => {
      if (!file.contentType || file.contentType.trim() === '') {
        throw new UnsupportedAttachmentTypeError(file.contentType);
      }
      const fileType = deriveFileType(file.contentType);
      const max = maxBytesFor(fileType);
      if (file.buffer.length > max) {
        throw new AttachmentTooLargeError(fileType, max, file.buffer.length);
      }
      return { ...file, fileType };
    });

    let sent: ChatwootMessageDto;
    try {
      sent = await this.gateway.sendMessage(
        conversation.chatwootConversationId,
        content,
        validatedFiles.length > 0 ? validatedFiles : undefined,
      );
    } catch {
      throw new ChatwootUnavailableError();
    }

    const message = await this.messageRepo.upsertByChatwootMessageId({
      conversationId: conversation.id,
      chatwootMessageId: sent.id,
      // Hardcoded 'outbound': this call ALWAYS represents a message WE just sent,
      // regardless of what the gateway DTO's (inbound-only-nullable) direction says.
      direction: 'outbound',
      content: sent.content,
      senderName: sent.senderName,
      chatwootCreatedAt: sent.createdAt,
    });

    // fix-be #1 — SEND-5 re-diseñado: cada fila se crea con la metadata de CHATWOOT
    // (nunca la del archivo local), queda `pending`, y el binario se baja async por
    // `sourceUrl` (mismo patrón que ReceiveChatwootWebhook/GetConversation). Sin
    // alineación posicional contra `validatedFiles` — jamás corrompe id↔binario.
    const sentAttachments = sent.attachments ?? [];
    if (sentAttachments.length !== validatedFiles.length) {
      // No aborta ni bloquea el envío — el mensaje YA salió. Solo deja rastro de que
      // Chatwoot descartó/reordenó/agregó algo respecto de lo que mandamos.
      console.error(
        '[messaging] SendMessage: Chatwoot echoed a different attachment count than sent — ' +
          'mirroring ONLY what Chatwoot actually confirmed (prevents positional corruption on drop/reorder)',
        { conversationId: conversation.id, messageId: message.id, sentCount: sentAttachments.length, filesSentCount: validatedFiles.length },
      );
    }

    const attachmentRecords: ChatMessageAttachmentRecord[] = [];
    for (const sentAttachment of sentAttachments) {
      try {
        const record = await this.attachmentRepo.upsertByChatwootAttachmentId({
          messageId: message.id,
          chatwootAttachmentId: sentAttachment.id,
          fileType: sentAttachment.fileType,
          contentType: sentAttachment.contentType,
          filename: sentAttachment.filename,
          sizeBytes: sentAttachment.sizeBytes,
          width: sentAttachment.width,
          height: sentAttachment.height,
          sourceUrl: sentAttachment.sourceUrl,
          thumbSourceUrl: sentAttachment.thumbSourceUrl,
        });
        attachmentRecords.push(record);

        this.downloadTrigger?.requestDownload(record.id);
      } catch (err) {
        // SEND-8 — a Prisma failure mirroring ONE attachment (or a synchronous throw
        // from the trigger's infra impl) must NEVER abort the send nor flip the HTTP
        // status: the WhatsApp message already went out. Logged, loop continues with
        // the rest of the batch; this row is simply absent from the response DTO
        // (no half-written/corrupted row is left behind).
        console.error(
          '[messaging] SendMessage: failed to mirror/trigger download for a sent attachment (message already sent, isolated per SEND-8)',
          { conversationId: conversation.id, messageId: message.id, chatwootAttachmentId: sentAttachment.id, error: err },
        );
      }
    }

    // messaging-inbox-polish (F1.5) — same WhatsApp-style rule as the inbound webhook:
    // when WE send media-only (empty caption), the mirror preview shows "📷 Imagen"/etc
    // from what Chatwoot echoed back, instead of a blank "Sin mensajes" in the list.
    await this.conversationRepo.upsertByChatwootId({
      chatwootConversationId: conversation.chatwootConversationId,
      lastMessageAt: sent.createdAt,
      lastMessagePreview: deriveConversationPreview(
        sent.content,
        sentAttachments.map((a) => a.fileType),
      ),
    });

    return toChatMessageDto(message, attachmentRecords);
  }
}
