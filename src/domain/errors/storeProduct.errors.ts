import { DomainError } from './index';

/**
 * store-backend — errores de dominio del catálogo (admin) y del pedido
 * (portal). Cada `code` es contrato de wire; el mapeo a status vive en
 * `errorHandler.ts` (statusMap), fuente única — ver ese archivo:
 *   STORE_PRODUCT_NOT_FOUND              → 404
 *   VALIDATION_ERROR                     → 400 (ya mapeado, reusado)
 *   STORE_ORDER_INSTALLMENTS_INVALID     → 400
 *   UNSUPPORTED_STORE_PRODUCT_IMAGE_TYPE → 415
 *   STORE_PRODUCT_IMAGE_TOO_LARGE        → 413
 */

/** Admin CRUD — el producto referenciado por `id` no existe. */
export class StoreProductNotFoundError extends DomainError {
  constructor(id: string) {
    super(`StoreProduct with id ${id} not found`, 'STORE_PRODUCT_NOT_FOUND');
    this.name = 'StoreProductNotFoundError';
  }
}

/** Admin CRUD — payload inválido (create/update, fuera de lo que ya cubre Zod). */
export class StoreProductValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'StoreProductValidationError';
  }
}

/** Portal — `installments` fuera de `[1, maxInstallments]` del producto. */
export class StoreOrderInstallmentsInvalidError extends DomainError {
  constructor(maxInstallments: number) {
    super(`installments debe estar entre 1 y ${maxInstallments}`, 'STORE_ORDER_INSTALLMENTS_INVALID');
    this.name = 'StoreOrderInstallmentsInvalidError';
  }
}

/** Admin — la imagen subida no es un tipo soportado (mismo criterio que ticketMessageAttachments: magic bytes del contenido real). */
export class UnsupportedStoreProductImageTypeError extends DomainError {
  constructor(public readonly mimeType: string) {
    super(`Unsupported store product image type: ${mimeType}`, 'UNSUPPORTED_STORE_PRODUCT_IMAGE_TYPE');
    this.name = 'UnsupportedStoreProductImageTypeError';
  }
}

/** Admin — la imagen subida excede el tope de tamaño (8MB, MAX_IMAGE_BYTES). */
export class StoreProductImageTooLargeError extends DomainError {
  constructor(public readonly maxBytes: number) {
    super(`Store product image exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB limit`, 'STORE_PRODUCT_IMAGE_TOO_LARGE');
    this.name = 'StoreProductImageTooLargeError';
  }
}
