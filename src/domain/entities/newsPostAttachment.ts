/**
 * N2 — adjunto de una NewsPost. Tres formas detrás de una entidad:
 *
 *  - 'image' / 'file' (BINARIO): el archivo vive en el storage (FileStorage/MinIO) bajo
 *    `storageKey` (prefijo `news/{newsPostId}/`); la fila lleva filename/mimeType/sizeBytes.
 *    `url` es null (no es un link externo).
 *  - 'link' (EXTERNO): NO hay binario. `url` apunta a un recurso externo; storageKey,
 *    mimeType y sizeBytes son null. `filename` es un rótulo opcional para el FE.
 *
 * Espejo de ScheduledTaskAttachment, pero SIN thumbnails/dimensiones (las noticias no
 * generan miniaturas) y CON el modo link, que task-photos no tiene.
 */
export type NewsPostAttachmentKind = 'image' | 'file' | 'link';

export interface NewsPostAttachment {
  id: string;
  newsPostId: string;
  kind: NewsPostAttachmentKind;
  /** Key del objeto en el storage (binarios). null para 'link'. */
  storageKey: string | null;
  /** Nombre de archivo (binarios) o rótulo (link). Puede ser null en un link sin rótulo. */
  filename: string | null;
  /** MIME del binario. null para 'link'. */
  mimeType: string | null;
  /** Tamaño del binario en bytes. null para 'link'. */
  sizeBytes: number | null;
  /** URL externa (solo 'link'). null para binarios. */
  url: string | null;
  uploadedById: string;
  createdAt: string; // ISO-8601
}

export interface CreateNewsPostAttachmentInput {
  id: string;
  newsPostId: string;
  kind: NewsPostAttachmentKind;
  storageKey?: string | null;
  filename?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  url?: string | null;
  uploadedById: string;
  createdAt?: string;
}

/**
 * Factory para NewsPostAttachment. Valida invariantes por `kind`:
 *  - link:   `url` no vacía; storageKey/mimeType/sizeBytes se fuerzan a null; filename opcional.
 *  - binario: `storageKey`, `filename`, `mimeType` requeridos y `sizeBytes` > 0; url null.
 * Siempre: `uploadedById` requerido.
 */
export function createNewsPostAttachment(
  input: CreateNewsPostAttachmentInput,
): NewsPostAttachment {
  if (!input.uploadedById || !input.uploadedById.trim()) {
    throw new Error('Attachment uploadedById is required');
  }

  if (input.kind === 'link') {
    if (!input.url || !input.url.trim()) {
      throw new Error('Link attachment requires a url');
    }
    const label = input.filename?.trim();
    return {
      id: input.id,
      newsPostId: input.newsPostId,
      kind: 'link',
      storageKey: null,
      filename: label && label.length > 0 ? label : null,
      mimeType: null,
      sizeBytes: null,
      url: input.url.trim(),
      uploadedById: input.uploadedById,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
  }

  // binario (image | file)
  if (!input.storageKey || !input.storageKey.trim()) {
    throw new Error('Binary attachment requires a storageKey');
  }
  if (!input.filename || !input.filename.trim()) {
    throw new Error('Binary attachment filename is required');
  }
  if (!input.mimeType || !input.mimeType.trim()) {
    throw new Error('Binary attachment mimeType is required');
  }
  if (!(typeof input.sizeBytes === 'number' && input.sizeBytes > 0)) {
    throw new Error('Binary attachment sizeBytes must be greater than 0');
  }
  return {
    id: input.id,
    newsPostId: input.newsPostId,
    kind: input.kind,
    storageKey: input.storageKey,
    filename: input.filename.trim(),
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    url: null,
    uploadedById: input.uploadedById,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
