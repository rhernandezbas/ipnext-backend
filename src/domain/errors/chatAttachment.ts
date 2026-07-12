/**
 * messaging-inbox-v2-media (F1.5 fase A, Tanda 1 · B1.7) — typed errors for
 * `ChatMessageAttachment` (chat media). HTTP mapping lives in errorHandler.ts
 * statusMap (single source of truth), clon del criterio de `domain/errors/taskAttachment.ts`.
 */
import { DomainError } from './index';

/**
 * El tamaño real del adjunto (reportado por Chatwoot o los bytes efectivamente
 * bajados) excede el límite del `fileType` (imagen 5MB, video/audio 16MB,
 * documento 100MB — spec MEDIA-2). HTTP → 413.
 */
export class AttachmentTooLargeError extends DomainError {
  constructor(
    public readonly fileType: string,
    public readonly maxBytes: number,
    public readonly actualBytes: number,
  ) {
    super(
      `Attachment of type "${fileType}" (${actualBytes} bytes) exceeds the maximum of ${maxBytes} bytes`,
      'CHAT_ATTACHMENT_TOO_LARGE',
    );
    this.name = 'AttachmentTooLargeError';
  }
}

/**
 * No existe ningún `ChatMessageAttachment` con ese id. HTTP → 404.
 */
export class ChatAttachmentNotFoundError extends DomainError {
  constructor(public readonly id: string) {
    super(`Chat attachment with id ${id} not found`, 'CHAT_ATTACHMENT_NOT_FOUND');
    this.name = 'ChatAttachmentNotFoundError';
  }
}

/**
 * El attachment existe pero todavía no está `downloaded` (`pending`/`failed`) —
 * el endpoint de servido no tiene binario que devolver todavía. HTTP → 409.
 */
export class ChatAttachmentNotReadyError extends DomainError {
  constructor(
    public readonly id: string,
    public readonly status: string,
  ) {
    super(`Chat attachment ${id} is not ready yet (status: ${status})`, 'CHAT_ATTACHMENT_NOT_READY');
    this.name = 'ChatAttachmentNotReadyError';
  }
}
