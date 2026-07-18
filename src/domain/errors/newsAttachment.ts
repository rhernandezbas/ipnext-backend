import { DomainError } from './index';

/**
 * N2 — errores de dominio de los adjuntos de Noticias. Cada `code` es contrato de wire;
 * el errorHandler global lo mapea a un status (ver statusMap):
 *   UNSUPPORTED_NEWS_ATTACHMENT_TYPE → 415
 *   TOO_MANY_NEWS_ATTACHMENTS        → 422
 *   NEWS_ATTACHMENT_NOT_FOUND        → 404
 *   INVALID_LINK_ATTACHMENT          → 422
 */

/** El archivo subido no es un tipo permitido (imágenes / .md / pdf). HTTP → 415. */
export class UnsupportedNewsAttachmentTypeError extends DomainError {
  constructor(public readonly mimeType: string) {
    super(`Unsupported news attachment type: ${mimeType}`, 'UNSUPPORTED_NEWS_ATTACHMENT_TYPE');
    this.name = 'UnsupportedNewsAttachmentTypeError';
  }
}

/** El alta excede el máximo de adjuntos por noticia. HTTP → 422. */
export class TooManyNewsAttachmentsError extends DomainError {
  constructor(public readonly max: number) {
    super(`A news post cannot have more than ${max} attachments`, 'TOO_MANY_NEWS_ATTACHMENTS');
    this.name = 'TooManyNewsAttachmentsError';
  }
}

/** No existe ningún adjunto con ese id (o es un link, sin binario que servir). HTTP → 404. */
export class NewsAttachmentNotFoundError extends DomainError {
  constructor(public readonly id: string) {
    super(`News attachment with id ${id} not found`, 'NEWS_ATTACHMENT_NOT_FOUND');
    this.name = 'NewsAttachmentNotFoundError';
  }
}

/** La URL de un adjunto tipo link está vacía o no es http(s). HTTP → 422. */
export class InvalidLinkAttachmentError extends DomainError {
  constructor(message = 'Link attachment url must be a non-empty http(s) URL') {
    super(message, 'INVALID_LINK_ATTACHMENT');
    this.name = 'InvalidLinkAttachmentError';
  }
}
