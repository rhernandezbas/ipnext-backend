import { randomUUID } from 'crypto';
import { FileStorage } from '@domain/ports/FileStorage';
import { TaskAttachmentRepository } from '@domain/ports/TaskAttachmentRepository';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { ImageProcessor, ImageDimensions } from '@domain/ports/ImageProcessor';
import { createScheduledTaskAttachment } from '@domain/entities/scheduledTaskAttachment';
import { TaskNotFoundError } from '@domain/errors/scheduling';
import {
  UnsupportedAttachmentTypeError,
  TooManyAttachmentsError,
  ImageTooLargeError,
} from '@domain/errors/taskAttachment';
import {
  ScheduledTaskAttachmentDto,
  toScheduledTaskAttachmentDto,
} from '@application/dto/taskAttachment.dto';

/** Tope de adjuntos por tarea (negocio). */
export const MAX_ATTACHMENTS_PER_TASK = 15;
/** Tope de píxeles del original (anti decompression-bomb): 50 MP. */
export const MAX_IMAGE_PIXELS = 50_000_000;
/** Lado mayor del thumbnail en px. */
const THUMB_MAX_SIDE = 400;
/** Calidad JPEG del thumbnail. */
const THUMB_QUALITY = 70;
/** Sufijo de la key del thumbnail respecto del original. */
export const THUMB_KEY_SUFFIX = '.thumb.jpg';

/** Mimetypes de imagen aceptados → extensión de archivo. */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Tipos REALES (magic bytes) que aceptamos. Coinciden 1:1 con los valores de MIME_TO_EXT
 * (image-size usa 'jpg' para jpeg). Sirve para rechazar formatos que `inspect()` reconoce
 * como imagen pero NO soportamos (svg/gif/heic/tiff/…) aunque vengan declarados png/jpeg.
 */
const SUPPORTED_DETECTED_TYPES = new Set(['jpg', 'png', 'webp']);

export interface AttachPhotoFile {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
}

export interface AttachPhotosToTaskInput {
  taskId: string;
  uploadedById: string;
  files: AttachPhotoFile[];
}

/** Logger mínimo inyectable (default: console). */
export interface AttachmentLogger {
  warn(message: string): void;
}

/**
 * Adjunta una o varias fotos a una tarea.
 *
 * Flujo por archivo: valida tarea + mimetype + cupo (15) ANTES de escribir nada;
 * genera la storageKey `tasks/${taskId}/${uuid}.${ext}`; intenta (best-effort) leer
 * dimensiones + generar thumbnail vía ImageProcessor (si falla → warn y sigue, sin
 * thumb, width/height null); guarda el original en el FileStorage; persiste la fila.
 *
 * Depende SOLO de puertos (FileStorage, TaskAttachmentRepository, EntityLookup,
 * ImageProcessor) — sin Prisma ni jimp en esta capa (DIP estricto).
 */
export class AttachPhotosToTask {
  constructor(
    private readonly attachments: TaskAttachmentRepository,
    private readonly fileStorage: FileStorage,
    private readonly taskLookup: EntityLookup,
    private readonly imageProcessor: ImageProcessor,
    private readonly logger: AttachmentLogger = console,
  ) {}

  async execute(input: AttachPhotosToTaskInput): Promise<ScheduledTaskAttachmentDto[]> {
    // 1) la tarea debe existir
    const task = await this.taskLookup.findById(input.taskId);
    if (!task) throw new TaskNotFoundError(input.taskId);

    // 2) Validación UPFRONT de TODO el lote — ANTES de escribir o decodificar nada.
    //    Si una sola falla, NINGUNA se guarda (combina con la atomicidad de abajo).
    //    Guardamos las dims inspeccionadas (index-aligned con input.files) para reusarlas
    //    como width/height confiables en el paso 4 (no dependen de que `process` funcione).
    const inspected: ImageDimensions[] = [];
    for (const file of input.files) {
      // 2a) mimetype declarado soportado (primer filtro barato).
      if (!MIME_TO_EXT[file.mimeType]) {
        throw new UnsupportedAttachmentTypeError(file.mimeType);
      }
      // 2b) 0 bytes → basura, NUNCA llegar a guardar.
      if (!(file.buffer.length > 0)) {
        throw new UnsupportedAttachmentTypeError(file.mimeType);
      }
      // 2c) imagen REAL por magic bytes (no confiar en el Content-Type del cliente):
      //     inspect lee solo el header; si no la reconoce → no es imagen.
      const dims = this.imageProcessor.inspect(file.buffer);
      if (!dims) {
        throw new UnsupportedAttachmentTypeError(file.mimeType);
      }
      // 2c-bis) [4] el TIPO DETECTADO (magic bytes) debe ser una imagen soportada Y coincidir
      //     con el mimetype declarado. Cierra SVG/HEIC/TIFF/gif declarados como png/jpeg
      //     (image-size los reconoce y devuelve dims, pero no los soportamos / mienten el tipo).
      if (!SUPPORTED_DETECTED_TYPES.has(dims.type) || dims.type !== MIME_TO_EXT[file.mimeType]) {
        throw new UnsupportedAttachmentTypeError(file.mimeType);
      }
      // 2d) anti decompression-bomb: rechazar por dimensiones declaradas ANTES de decodificar.
      if (dims.width * dims.height > MAX_IMAGE_PIXELS) {
        throw new ImageTooLargeError(dims.width, dims.height, MAX_IMAGE_PIXELS);
      }
      inspected.push(dims);
    }

    // 3) cupo por tarea
    const existing = await this.attachments.countByTaskId(input.taskId);
    if (existing + input.files.length > MAX_ATTACHMENTS_PER_TASK) {
      throw new TooManyAttachmentsError(MAX_ATTACHMENTS_PER_TASK);
    }

    // 4) Escritura ATÓMICA (A1): trackeamos lo escrito para compensar si algo falla.
    //    O se crean TODAS o NINGUNA — sin huérfanos en storage ni filas duplicadas al reintentar.
    const created: ScheduledTaskAttachmentDto[] = [];
    const savedKeys: string[] = [];
    const createdIds: string[] = [];

    try {
      for (let i = 0; i < input.files.length; i++) {
        const file = input.files[i];
        const dims = inspected[i];
        const ext = MIME_TO_EXT[file.mimeType];
        const id = randomUUID();
        const storageKey = `tasks/${input.taskId}/${id}.${ext}`;

        // [5] width/height SIEMPRE desde inspect() (dims confiables y ya validadas en el
        //     paso 2). NO dependen de `process`: si el thumbnail falla best-effort, las
        //     dimensiones igual se persisten (antes quedaban null al venir de process).
        const width: number = dims.width;
        const height: number = dims.height;

        // Thumbnail: best-effort. `process` SOLO genera el thumbnail; si jimp no puede
        // decodificar el buffer, logueamos un warn y seguimos guardando SOLO el original.
        try {
          const processed = await this.imageProcessor.process(file.buffer, {
            maxSide: THUMB_MAX_SIDE,
            quality: THUMB_QUALITY,
          });
          const thumbKey = `${storageKey}${THUMB_KEY_SUFFIX}`;
          savedKeys.push(thumbKey); // trackear ANTES del save (delete es idempotente)
          await this.fileStorage.save({
            key: thumbKey,
            buffer: processed.thumbnail,
            mimeType: 'image/jpeg',
          });
        } catch (err) {
          this.logger.warn(
            `[AttachPhotosToTask] thumbnail generation failed for "${file.originalName}": ${(err as Error).message}`,
          );
        }

        // Original — siempre se guarda
        savedKeys.push(storageKey); // trackear ANTES del save
        await this.fileStorage.save({
          key: storageKey,
          buffer: file.buffer,
          mimeType: file.mimeType,
        });

        const entity = await this.attachments.create(
          createScheduledTaskAttachment({
            id,
            taskId: input.taskId,
            storageKey,
            filename: file.originalName,
            mimeType: file.mimeType,
            sizeBytes: file.buffer.length,
            width,
            height,
            uploadedById: input.uploadedById,
          }),
        );
        createdIds.push(entity.id);

        created.push(toScheduledTaskAttachmentDto(entity));
      }
    } catch (err) {
      // Compensación: deshacer TODO lo escrito en este lote (storage + repo), luego re-lanzar.
      // [3] Si un delete de cleanup FALLA, NO lo borramos en silencio: logueamos un warn con
      //     la key/id que quedó huérfana (sin rastro = imposible de GC después). El re-throw
      //     del error ORIGINAL se mantiene intacto.
      const storageResults = await Promise.allSettled(savedKeys.map((k) => this.fileStorage.delete(k)));
      storageResults.forEach((r, i) => {
        if (r.status === 'rejected') {
          this.logger.warn(
            `[AttachPhotosToTask] compensation failed to delete storage key "${savedKeys[i]}" (orphan left behind): ${String(r.reason)}`,
          );
        }
      });
      const repoResults = await Promise.allSettled(createdIds.map((id) => this.attachments.delete(id)));
      repoResults.forEach((r, i) => {
        if (r.status === 'rejected') {
          this.logger.warn(
            `[AttachPhotosToTask] compensation failed to delete attachment row "${createdIds[i]}" (orphan left behind): ${String(r.reason)}`,
          );
        }
      });
      throw err;
    }

    return created;
  }
}
