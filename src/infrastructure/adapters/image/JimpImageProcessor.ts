import { Jimp, JimpMime } from 'jimp';
import { imageSize } from 'image-size';
import {
  ImageProcessor,
  ProcessImageOptions,
  ProcessedImage,
  ImageDimensions,
} from '@domain/ports/ImageProcessor';

/**
 * Adapter de procesamiento de imágenes sobre jimp (mismo patrón que las adapters de
 * OCR/audit que ya usan jimp). Decodifica el buffer una sola vez, lee dimensiones y
 * produce un thumbnail JPEG. Si el buffer no es decodificable, `Jimp.read` LANZA y el
 * caller (AttachPhotosToTask) lo trata como best-effort.
 *
 * NO se testea con unit: jimp v1 hace un import() dinámico interno (detección de
 * formato) que Jest no soporta sin --experimental-vm-modules (mismo motivo por el que
 * las adapters de OCR/audit mockean su frontera). Se verifica en vivo, igual que
 * MinioFileStorage. El contrato del port ImageProcessor se cubre con stubs en los
 * tests de AttachPhotosToTask (happy + fallback best-effort) y de la ruta.
 */
export class JimpImageProcessor implements ImageProcessor {
  async process(buffer: Buffer, options: ProcessImageOptions): Promise<ProcessedImage> {
    const image = await Jimp.read(buffer);
    const width = image.width;
    const height = image.height;

    // No upscalear: solo reducimos si el lado mayor supera maxSide. scaleToFit
    // preserva aspecto encajando dentro de la caja maxSide×maxSide.
    if (Math.max(width, height) > options.maxSide) {
      image.scaleToFit({ w: options.maxSide, h: options.maxSide });
    }

    const thumbnail = await image.getBuffer(JimpMime.jpeg, { quality: options.quality });
    return { width, height, thumbnail };
  }

  /**
   * Header-only probe vía `image-size` (lee solo los magic bytes + dimensiones del
   * header; NO decodifica). Devuelve null si el buffer no es una imagen reconocible
   * (o si está vacío/corrupto) — image-size lanza en esos casos y lo traducimos a null.
   */
  inspect(buffer: Buffer): ImageDimensions | null {
    try {
      const dim = imageSize(buffer);
      if (!dim || !dim.width || !dim.height || !dim.type) return null;
      return { width: dim.width, height: dim.height, type: dim.type };
    } catch {
      return null;
    }
  }
}
