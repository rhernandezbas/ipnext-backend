import { DomainError } from './index';

/**
 * Errores de dominio de la feature task-photos (adjuntos de una ScheduledTask).
 * Cada uno lleva un `code` estable que el errorHandler HTTP mapea a un status.
 */

/**
 * El mimetype del archivo subido no es una imagen soportada
 * (solo image/jpeg, image/png, image/webp). HTTP → 415.
 */
export class UnsupportedAttachmentTypeError extends DomainError {
  constructor(public readonly mimeType: string) {
    super(`Unsupported attachment type: ${mimeType}`, 'UNSUPPORTED_ATTACHMENT_TYPE');
    this.name = 'UnsupportedAttachmentTypeError';
  }
}

/**
 * El alta excede el máximo de adjuntos por tarea. HTTP → 422.
 */
export class TooManyAttachmentsError extends DomainError {
  constructor(public readonly max: number) {
    super(`A task cannot have more than ${max} attachments`, 'TOO_MANY_ATTACHMENTS');
    this.name = 'TooManyAttachmentsError';
  }
}

/**
 * No existe ningún adjunto con ese id. HTTP → 404.
 */
export class AttachmentNotFoundError extends DomainError {
  constructor(public readonly id: string) {
    super(`Attachment with id ${id} not found`, 'ATTACHMENT_NOT_FOUND');
    this.name = 'AttachmentNotFoundError';
  }
}

/**
 * Las dimensiones declaradas de la imagen exceden el máximo permitido
 * (anti decompression-bomb: se rechaza por el header, ANTES de decodificar). HTTP → 422.
 */
export class ImageTooLargeError extends DomainError {
  constructor(
    public readonly width: number,
    public readonly height: number,
    public readonly maxPixels: number,
  ) {
    super(
      `Image dimensions ${width}x${height} exceed the maximum of ${maxPixels} pixels`,
      'IMAGE_TOO_LARGE',
    );
    this.name = 'ImageTooLargeError';
  }
}

/**
 * El storage de archivos (MinIO) no está configurado: faltan/están vacías las MINIO_*.
 * La feature de fotos degrada (no rompe el boot); cada operación falla limpio. HTTP → 503.
 */
export class StorageNotConfiguredError extends DomainError {
  constructor(message = 'File storage (MinIO) is not configured') {
    super(message, 'STORAGE_NOT_CONFIGURED');
    this.name = 'StorageNotConfiguredError';
  }
}
