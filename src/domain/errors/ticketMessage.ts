import { DomainError } from './index';

/**
 * portal-ticket-messaging (v2.B) — errores de dominio de la mensajería de
 * reclamos (cliente↔staff) y sus adjuntos (foto/audio/video). Cada `code` es
 * contrato de wire; el errorHandler global lo mapea a un status:
 *   TICKET_MESSAGE_VALIDATION            → 400
 *   UNSUPPORTED_TICKET_MESSAGE_ATTACHMENT_TYPE → 415
 *   TICKET_MESSAGE_ATTACHMENT_TOO_LARGE  → 413
 *   TOO_MANY_TICKET_MESSAGE_ATTACHMENTS  → 422
 *   TICKET_MESSAGE_ATTACHMENT_NOT_FOUND  → 404
 */

/** Contenido vacío (sin texto ni adjuntos) o que excede el largo máximo. HTTP → 400. */
export class TicketMessageValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'TICKET_MESSAGE_VALIDATION');
    this.name = 'TicketMessageValidationError';
  }
}

/** El adjunto no es un tipo permitido (imagen/audio/video de la allowlist). HTTP → 415. */
export class UnsupportedTicketMessageAttachmentTypeError extends DomainError {
  constructor(public readonly mimeType: string) {
    super(`Unsupported ticket message attachment type: ${mimeType}`, 'UNSUPPORTED_TICKET_MESSAGE_ATTACHMENT_TYPE');
    this.name = 'UnsupportedTicketMessageAttachmentTypeError';
  }
}

/** El adjunto excede el tope de tamaño de su categoría (imagen/audio/video). HTTP → 413. */
export class TicketMessageAttachmentTooLargeError extends DomainError {
  constructor(
    public readonly kind: 'image' | 'audio' | 'video',
    public readonly maxBytes: number,
  ) {
    super(`Attachment of kind "${kind}" exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB limit`, 'TICKET_MESSAGE_ATTACHMENT_TOO_LARGE');
    this.name = 'TicketMessageAttachmentTooLargeError';
  }
}

/** El alta excede el máximo de adjuntos por mensaje. HTTP → 422. */
export class TooManyTicketMessageAttachmentsError extends DomainError {
  constructor(public readonly max: number) {
    super(`A ticket message cannot have more than ${max} attachments`, 'TOO_MANY_TICKET_MESSAGE_ATTACHMENTS');
    this.name = 'TooManyTicketMessageAttachmentsError';
  }
}

/** No existe ningún adjunto de mensajería con ese id, o no pertenece a lo pedido. HTTP → 404. */
export class TicketMessageAttachmentNotFoundError extends DomainError {
  constructor(public readonly id: string) {
    super(`Ticket message attachment with id ${id} not found`, 'TICKET_MESSAGE_ATTACHMENT_NOT_FOUND');
    this.name = 'TicketMessageAttachmentNotFoundError';
  }
}

/**
 * F11 (fix wave) — el storage (MinIO) no respondió al guardar un adjunto:
 * caído/inalcanzable/timeout, DISTINTO de "no configurado"
 * (`StorageNotConfiguredError`, `taskAttachment.ts`, también 503 pero por un
 * motivo de config, no de infra caída). `createTicketMessageWithAttachments`
 * envuelve acá cualquier error NO-domain que tire `fileStorage.save` — antes
 * ese error crudo (ECONNREFUSED, timeout) caía al 500 genérico del
 * errorHandler. HTTP → 503 (transitorio, vale la pena reintentar).
 */
export class TicketMessageStorageUnavailableError extends DomainError {
  constructor(detail: string) {
    super(`Ticket message attachment storage is unavailable: ${detail}`, 'TICKET_MESSAGE_STORAGE_UNAVAILABLE');
    this.name = 'TicketMessageStorageUnavailableError';
  }
}
