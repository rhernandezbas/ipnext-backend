/**
 * Port de procesamiento de imágenes (dimensiones + thumbnail).
 *
 * El adapter concreto (jimp en prod) vive en infrastructure; la capa de aplicación
 * depende SOLO de este puerto y se mantiene pura (DIP estricto, mismo patrón que
 * `DevicePhotoOcr`). La implementación PUEDE lanzar si el buffer no es una imagen
 * decodificable — los callers que quieran best-effort deben capturar.
 */
export interface ProcessedImage {
  /** Ancho del original en px. */
  width: number;
  /** Alto del original en px. */
  height: number;
  /** Thumbnail JPEG (lado mayor acotado a `maxSide`). */
  thumbnail: Buffer;
}

export interface ProcessImageOptions {
  /** Lado mayor máximo del thumbnail, en px. */
  maxSide: number;
  /** Calidad JPEG del thumbnail (1..100). */
  quality: number;
}

/** Dimensiones + tipo leídos del header de la imagen (sin decodificar). */
export interface ImageDimensions {
  width: number;
  height: number;
  /**
   * Tipo REAL detectado por magic bytes (ej. 'jpg' | 'png' | 'webp' | 'gif' | 'svg' | ...).
   * Nota: para JPEG el detector usa 'jpg' (no 'jpeg'). Permite rechazar formatos
   * declarados-pero-falsos (SVG/HEIC/TIFF como image/png) sin confiar en el Content-Type.
   */
  type: string;
}

export interface ImageProcessor {
  /**
   * Decodifica `buffer`, devuelve sus dimensiones y un thumbnail JPEG.
   * LANZA si `buffer` no es una imagen decodificable.
   */
  process(buffer: Buffer, options: ProcessImageOptions): Promise<ProcessedImage>;

  /**
   * Sondea SOLO el header del buffer (magic bytes + dimensiones declaradas) SIN
   * decodificar los píxeles. Devuelve `null` si `buffer` no es una imagen reconocible.
   *
   * Bomb-safe: nunca aloca el framebuffer, así que sirve para rechazar decompression
   * bombs (dimensiones declaradas gigantes) ANTES de que `process` decodifique, y para
   * validar el tipo real por magic bytes (no confiar en el Content-Type del cliente).
   */
  inspect(buffer: Buffer): ImageDimensions | null;
}
