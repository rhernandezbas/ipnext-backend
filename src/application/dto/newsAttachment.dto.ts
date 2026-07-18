import { z } from 'zod';
import { NewsPostAttachment } from '@domain/entities/newsPostAttachment';

/**
 * N2 — validación del body JSON al adjuntar un LINK (POST /:id/attachments, rama sin archivos).
 * Guarda de TIPO: garantiza que `url`/`filename` sean strings ANTES de que el use case haga
 * `.trim()` — un `url` no-string ({}, array, number) reventaba con TypeError crudo → 500.
 * Zod lo corta en 400 VALIDATION_ERROR. La semántica del esquema http(s) NO se valida acá:
 * sigue en AttachLinkToNews → InvalidLinkAttachmentError (422), que queda intacta (ftp://…, etc.).
 */
export const AttachLinkBodySchema = z.object({
  kind: z.literal('link'),
  url: z.string(),
  filename: z.string().optional(),
});

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
