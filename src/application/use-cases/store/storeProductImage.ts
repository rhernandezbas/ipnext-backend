import {
  IMAGE_MIME_TO_EXT,
  MAGIC_BYTE_SNIFFERS,
  MAX_IMAGE_BYTES,
} from '@application/use-cases/ticketMessageAttachments';
import {
  UnsupportedStoreProductImageTypeError,
  StoreProductImageTooLargeError,
} from '@domain/errors/storeProduct.errors';

/**
 * store-backend — validación de la imagen de un producto. REUSA el pipeline
 * de adjuntos de mensajería (`ticketMessageAttachments.ts`): la MISMA
 * allowlist de mimeTypes de imagen (`IMAGE_MIME_TO_EXT`) y los MISMOS
 * sniffers de magic bytes del contenido real (`MAGIC_BYTE_SNIFFERS`) — un PNG
 * renombrado `.jpg` con `Content-Type: image/jpeg` falso se rechaza porque el
 * contenido no matchea la firma JPEG declarada, exactamente igual que un
 * adjunto de ticket. Cap propio de 8MB (`MAX_IMAGE_BYTES`, ya el tope de
 * imagen del pipeline reusado — no se inventa un número nuevo).
 */
export interface StoreProductImageFile {
  buffer: Buffer;
  mimeType: string;
}

export interface StoreProductImageClassification {
  ext: string;
  mimeType: string;
}

export function validateStoreProductImage(file: StoreProductImageFile): StoreProductImageClassification {
  if (!(file.buffer.length > 0)) {
    throw new UnsupportedStoreProductImageTypeError(file.mimeType);
  }
  const ext = IMAGE_MIME_TO_EXT[file.mimeType];
  if (!ext) {
    throw new UnsupportedStoreProductImageTypeError(file.mimeType);
  }
  const sniff = MAGIC_BYTE_SNIFFERS[file.mimeType];
  if (!sniff || !sniff(file.buffer)) {
    throw new UnsupportedStoreProductImageTypeError(file.mimeType);
  }
  if (file.buffer.length > MAX_IMAGE_BYTES) {
    throw new StoreProductImageTooLargeError(MAX_IMAGE_BYTES);
  }
  return { ext, mimeType: file.mimeType };
}
