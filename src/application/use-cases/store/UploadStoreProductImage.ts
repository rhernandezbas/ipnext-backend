import { randomUUID } from 'crypto';
import type { StoreProductRepository } from '@domain/ports/StoreProductRepository';
import type { FileStorage } from '@domain/ports/FileStorage';
import type { StoreProductAdminDto } from '@application/dto/storeProducts.dto';
import { toStoreProductAdminDto } from '@application/dto/storeProducts.dto';
import { StoreProductNotFoundError } from '@domain/errors/storeProduct.errors';
import { validateStoreProductImage, StoreProductImageFile } from './storeProductImage';

/**
 * UploadStoreProductImage — admin, `POST /api/store/products/:id/image`
 * (multipart, campo `file`).
 *
 * La rebanada de imagen va COMPLETA en este change (subir + servir) — a
 * diferencia de portal-promos, donde quedó deliberadamente incompleta (ver
 * `promos.dto.ts`). Orden: valida el producto ANTES de tocar storage (no
 * guardar un binario huérfano si el id no existe); valida el contenido
 * (magic bytes) ANTES de guardar; si el producto YA tenía imagen, la vieja se
 * borra DESPUÉS de que la nueva quedó guardada y el `update` confirmó —
 * nunca al revés (una key vieja borrada antes de tiempo deja al producto sin
 * imagen si el `update` falla a mitad de camino).
 */
export class UploadStoreProductImage {
  constructor(
    private readonly products: StoreProductRepository,
    private readonly fileStorage: FileStorage,
  ) {}

  async execute(productId: string, file: StoreProductImageFile): Promise<StoreProductAdminDto> {
    const product = await this.products.findById(productId);
    if (!product) throw new StoreProductNotFoundError(productId);

    const classification = validateStoreProductImage(file);
    const newKey = `store-products/${productId}/${randomUUID()}.${classification.ext}`;
    await this.fileStorage.save({ key: newKey, buffer: file.buffer, mimeType: classification.mimeType });

    const updated = await this.products.update(productId, { imageStorageKey: newKey });
    if (!updated) {
      // Defensivo — el producto existía hace un instante (findById arriba).
      // Compensación: no dejar un binario huérfano en storage.
      await this.fileStorage.delete(newKey);
      throw new StoreProductNotFoundError(productId);
    }

    if (product.imageStorageKey && product.imageStorageKey !== newKey) {
      await this.fileStorage.delete(product.imageStorageKey);
    }

    return toStoreProductAdminDto(updated);
  }
}
