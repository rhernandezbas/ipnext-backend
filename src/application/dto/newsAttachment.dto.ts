import { NewsPostAttachment } from '@domain/entities/newsPostAttachment';

/**
 * N2 — DTO de salida de un adjunto de Noticia.
 *
 * NUNCA expone `storageKey` (interna). En su lugar:
 *  - binarios (image/file): `fileUrl` = ruta relativa al endpoint BE-proxy que sirve el
 *    binario; `url` null.
 *  - links: `url` = la URL externa; `fileUrl` null.
 */
export interface NewsPostAttachmentDto {
  id: string;
  newsPostId: string;
  kind: 'image' | 'file' | 'link';
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  /** URL externa (solo links). null para binarios. */
  url: string | null;
  /** Ruta al binario (BE-proxy). null para links. */
  fileUrl: string | null;
  uploadedById: string;
  createdAt: string;
}

/** Base del endpoint que sirve el binario (alineada con newsMedia.routes montado en /api/news). */
const NEWS_ATTACHMENTS_FILE_BASE = '/api/news/attachments';

export function toNewsPostAttachmentDto(a: NewsPostAttachment): NewsPostAttachmentDto {
  const isLink = a.kind === 'link';
  return {
    id: a.id,
    newsPostId: a.newsPostId,
    kind: a.kind,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    url: isLink ? a.url : null,
    fileUrl: isLink ? null : `${NEWS_ATTACHMENTS_FILE_BASE}/${a.id}/file`,
    uploadedById: a.uploadedById,
    createdAt: a.createdAt,
  };
}
