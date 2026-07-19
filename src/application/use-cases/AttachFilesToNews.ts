import { randomUUID } from 'crypto';
import { FileStorage } from '@domain/ports/FileStorage';
import { NewsPostAttachmentRepository } from '@domain/ports/NewsPostAttachmentRepository';
import { NewsPostRepository } from '@domain/ports/NewsPostRepository';
import {
  createNewsPostAttachment,
  NewsPostAttachmentKind,
} from '@domain/entities/newsPostAttachment';
import { NewsPostNotFoundError } from '@domain/errors/news';
import {
  UnsupportedNewsAttachmentTypeError,
  TooManyNewsAttachmentsError,
} from '@domain/errors/newsAttachment';
import {
  NewsPostAttachmentDto,
  toNewsPostAttachmentDto,
} from '@application/dto/newsAttachment.dto';

/** Tope de adjuntos por noticia (negocio). */
export const MAX_ATTACHMENTS_PER_POST = 20;

/**
 * Tipos permitidos (decisión + documentación N2):
 *  - Imágenes: jpeg, png, webp, gif
 *  - Documentos: pdf, markdown (.md)
 *
 * El `.md` de un navegador llega con MIME inconsistente (text/plain, application/
 * octet-stream, a veces text/markdown), así que se acepta por EXTENSIÓN `.md` y se
 * normaliza a `text/markdown`. Los demás se validan por el MIME declarado.
 */
const IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const FILE_MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/markdown': 'md',
};

export interface NewsFileClassification {
  kind: NewsPostAttachmentKind; // 'image' | 'file'
  ext: string;
  mimeType: string;
}

/** Extensión `.md` primero (robusto al MIME que manda el browser), luego allowlist de MIME. */
function classify(originalName: string, mimeType: string): NewsFileClassification | null {
  if (/\.md$/i.test(originalName)) {
    return { kind: 'file', ext: 'md', mimeType: 'text/markdown' };
  }
  if (IMAGE_MIME_TO_EXT[mimeType]) {
    return { kind: 'image', ext: IMAGE_MIME_TO_EXT[mimeType]!, mimeType };
  }
  if (FILE_MIME_TO_EXT[mimeType]) {
    return { kind: 'file', ext: FILE_MIME_TO_EXT[mimeType]!, mimeType };
  }
  return null;
}

export interface AttachNewsFile {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
}

/**
 * Valida TODO el lote de archivos SIN escribir nada: rechaza 0-byte y tipos no
 * permitidos (imágenes / .md / pdf) con `UnsupportedNewsAttachmentTypeError`. Devuelve
 * las clasificaciones (kind/ext/mimeType normalizado) en el MISMO orden de entrada.
 *
 * Función PURA exportada para poder validar upfront desde otros orquestadores (ej.
 * CreateExternalNews, que NO debe crear el post si un archivo tiene tipo inválido). El
 * `execute` de AttachFilesToNews la reusa internamente — comportamiento idéntico.
 */
export function validateNewsFilesBatch(files: AttachNewsFile[]): NewsFileClassification[] {
  const classified: NewsFileClassification[] = [];
  for (const file of files) {
    if (!(file.buffer.length > 0)) {
      throw new UnsupportedNewsAttachmentTypeError(file.mimeType);
    }
    const c = classify(file.originalName, file.mimeType);
    if (!c) throw new UnsupportedNewsAttachmentTypeError(file.mimeType);
    classified.push(c);
  }
  return classified;
}

export interface AttachFilesToNewsInput {
  newsPostId: string;
  uploadedById: string;
  files: AttachNewsFile[];
}

export interface NewsAttachmentLogger {
  warn(message: string): void;
}

/**
 * Adjunta uno o varios binarios (imágenes/archivos) a una noticia.
 *
 * Flujo: valida que la noticia exista → valida TODO el lote (tipo + 0 bytes) ANTES de
 * escribir → chequea cupo → escritura ATÓMICA con compensación (si algo falla, deshace
 * storage + filas escritas y re-lanza el error original). SIN thumbnails (las noticias no
 * los generan). Depende SOLO de puertos (DIP estricto).
 */
export class AttachFilesToNews {
  constructor(
    private readonly attachments: NewsPostAttachmentRepository,
    private readonly fileStorage: FileStorage,
    private readonly posts: Pick<NewsPostRepository, 'findById'>,
    private readonly logger: NewsAttachmentLogger = console,
  ) {}

  async execute(input: AttachFilesToNewsInput): Promise<NewsPostAttachmentDto[]> {
    // 1) la noticia debe existir (findById requiere userId — el autor de la subida sirve).
    const post = await this.posts.findById(input.newsPostId, input.uploadedById);
    if (!post) throw new NewsPostNotFoundError(input.newsPostId);

    // 2) Validación UPFRONT del lote — antes de escribir nada (tipo + 0 bytes).
    const classified = validateNewsFilesBatch(input.files);

    // 3) cupo por noticia
    const existing = await this.attachments.countByNewsPostId(input.newsPostId);
    if (existing + input.files.length > MAX_ATTACHMENTS_PER_POST) {
      throw new TooManyNewsAttachmentsError(MAX_ATTACHMENTS_PER_POST);
    }

    // 4) Escritura ATÓMICA con compensación: o TODAS o NINGUNA.
    const created: NewsPostAttachmentDto[] = [];
    const savedKeys: string[] = [];
    const createdIds: string[] = [];

    try {
      for (let i = 0; i < input.files.length; i++) {
        const file = input.files[i]!;
        const c = classified[i]!;
        const id = randomUUID();
        const storageKey = `news/${input.newsPostId}/${id}.${c.ext}`;

        savedKeys.push(storageKey); // trackear ANTES del save (delete es idempotente)
        await this.fileStorage.save({ key: storageKey, buffer: file.buffer, mimeType: c.mimeType });

        const entity = await this.attachments.create(
          createNewsPostAttachment({
            id,
            newsPostId: input.newsPostId,
            kind: c.kind,
            storageKey,
            filename: file.originalName,
            mimeType: c.mimeType,
            sizeBytes: file.buffer.length,
            uploadedById: input.uploadedById,
          }),
        );
        createdIds.push(entity.id);
        created.push(toNewsPostAttachmentDto(entity));
      }
    } catch (err) {
      const storageResults = await Promise.allSettled(savedKeys.map((k) => this.fileStorage.delete(k)));
      storageResults.forEach((r, i) => {
        if (r.status === 'rejected') {
          this.logger.warn(
            `[AttachFilesToNews] compensation failed to delete storage key "${savedKeys[i]}" (orphan left behind): ${String(r.reason)}`,
          );
        }
      });
      const repoResults = await Promise.allSettled(createdIds.map((id) => this.attachments.delete(id)));
      repoResults.forEach((r, i) => {
        if (r.status === 'rejected') {
          this.logger.warn(
            `[AttachFilesToNews] compensation failed to delete attachment row "${createdIds[i]}" (orphan left behind): ${String(r.reason)}`,
          );
        }
      });
      throw err;
    }

    return created;
  }
}
