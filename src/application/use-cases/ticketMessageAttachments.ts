import { randomUUID } from 'crypto';
import { FileStorage } from '@domain/ports/FileStorage';
import { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import { TicketComment, TicketCommentAttachment, TicketCommentAttachmentKind, TicketCommentAuthorKind, TicketCommentVisibility } from '@domain/entities/ticketComment';
import {
  TicketMessageValidationError,
  UnsupportedTicketMessageAttachmentTypeError,
  TicketMessageAttachmentTooLargeError,
  TooManyTicketMessageAttachmentsError,
} from '@domain/errors/ticketMessage';

/**
 * portal-ticket-messaging (v2.B) — límites y tipos permitidos de adjuntos de la
 * mensajería (foto/audio/video), compartidos por `SendPortalTicketMessage`
 * (cliente) y `SendStaffTicketReply` (staff). Documentación de la elección:
 *
 *  - Imagen: 8MB. El sistema VIEJO de notas internas topea en 2MB porque
 *    guarda el binario como data-URI DENTRO de la fila de Postgres (bloat de
 *    tabla); acá el binario vive en MinIO (patrón BE-proxy), así que ese techo
 *    no aplica — 8MB cubre una foto de cámara de celular sin comprimir agresivo.
 *  - Audio: 15MB (~10-15 min de nota de voz a bitrate típico de compresión).
 *  - Video: 40MB. DEUDA DE STREAMING (ver GetTicketMessageAttachmentFile): el
 *    patrón BE-proxy de este repo (`res.send(buffer)`, molde `newsMedia.routes`)
 *    carga el archivo ENTERO en RAM para servirlo — no hay range-requests ni
 *    streaming real todavía. 40MB es un techo pensado para un clip corto de
 *    celular (30-60s) sin arriesgar el proceso Node bajo carga concurrente; un
 *    video más largo necesita servirse distinto (streaming real / CDN), fuera
 *    de alcance de este change.
 *  - Máximo 5 adjuntos por mensaje, 60MB de batch combinado por request (mismo
 *    patrón que `messaging.routes.ts` MAX_TOTAL_BATCH_BYTES — el cap por-archivo
 *    reduce el pico de UN adjunto, el cap de batch evita que 5 adjuntos al tope
 *    individual sumen un pico de RAM des-cubierto).
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_TOTAL_BATCH_BYTES = 60 * 1024 * 1024;
/**
 * Largo máximo del texto de un mensaje — coherente con
 * `PORTAL_TICKET_DESCRIPTION_MAX_LEN` (5000, CreatePortalTicket.ts), un poco
 * más chico porque un mensaje de chat es, por naturaleza, más corto que la
 * descripción inicial de un reclamo. Aplica a AMBOS lados (cliente y staff) —
 * una sola constante, una sola fuente de verdad.
 */
export const MAX_MESSAGE_BODY_LEN = 4000;

// SVG excluido a propósito (mismo motivo que newsAttachment.ts): puede llevar
// <script>, stored-XSS si se sirve inline.
const IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const AUDIO_MIME_TO_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'weba',
  'audio/x-m4a': 'm4a',
};
const VIDEO_MIME_TO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
};

interface Classification {
  kind: TicketCommentAttachmentKind;
  ext: string;
  mimeType: string;
  maxBytes: number;
}

function classify(mimeType: string): Classification | null {
  if (IMAGE_MIME_TO_EXT[mimeType]) return { kind: 'image', ext: IMAGE_MIME_TO_EXT[mimeType]!, mimeType, maxBytes: MAX_IMAGE_BYTES };
  if (AUDIO_MIME_TO_EXT[mimeType]) return { kind: 'audio', ext: AUDIO_MIME_TO_EXT[mimeType]!, mimeType, maxBytes: MAX_AUDIO_BYTES };
  if (VIDEO_MIME_TO_EXT[mimeType]) return { kind: 'video', ext: VIDEO_MIME_TO_EXT[mimeType]!, mimeType, maxBytes: MAX_VIDEO_BYTES };
  return null;
}

export interface TicketMessageFile {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
}

/**
 * Valida TODO el lote SIN escribir nada: cupo, tipo, 0-byte y tamaño por
 * categoría. Devuelve las clasificaciones en el MISMO orden de entrada — molde
 * `validateNewsFilesBatch` (AttachFilesToNews.ts).
 */
export function validateTicketMessageFilesBatch(files: TicketMessageFile[]): Classification[] {
  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new TooManyTicketMessageAttachmentsError(MAX_ATTACHMENTS_PER_MESSAGE);
  }
  const classified: Classification[] = [];
  for (const file of files) {
    if (!(file.buffer.length > 0)) {
      throw new UnsupportedTicketMessageAttachmentTypeError(file.mimeType);
    }
    const c = classify(file.mimeType);
    if (!c) throw new UnsupportedTicketMessageAttachmentTypeError(file.mimeType);
    if (file.buffer.length > c.maxBytes) {
      throw new TicketMessageAttachmentTooLargeError(c.kind, c.maxBytes);
    }
    classified.push(c);
  }
  return classified;
}

export interface CreateTicketMessageParams {
  ticketId: string;
  authorId: string | null;
  authorKind: TicketCommentAuthorKind;
  visibility: TicketCommentVisibility;
  authorName: string;
  body: string;
  files: TicketMessageFile[];
}

export interface TicketMessageLogger {
  warn(message: string): void;
}

/**
 * Crea un `TicketComment` + sus adjuntos, con escritura ATÓMICA: valida TODO el
 * lote primero, guarda los binarios en MinIO, y RECIÉN AHÍ crea la fila (comment
 * + attachments en un solo `create` anidado). Si CUALQUIER paso falla después de
 * haber guardado algún binario (otro archivo del lote, o el propio `create` de
 * la fila), se compensa borrando TODO lo ya guardado en storage — no debe quedar
 * un adjunto huérfano en MinIO sin fila que lo referencie. Comparte el patrón de
 * compensación de `AttachFilesToNews`, simplificado: acá hay UNA sola fila
 * (comment) en vez de N filas de attachment independientes, así que la
 * compensación de storage alcanza (no hay filas parciales de DB que deshacer:
 * el nested-create de Prisma es atómico por sí mismo).
 */
export async function createTicketMessageWithAttachments(
  comments: TicketCommentRepository,
  fileStorage: FileStorage,
  params: CreateTicketMessageParams,
  logger: TicketMessageLogger = console,
): Promise<TicketComment> {
  const classified = validateTicketMessageFilesBatch(params.files);

  if (params.body.trim().length === 0 && params.files.length === 0) {
    throw new TicketMessageValidationError('El mensaje no puede estar vacío: falta texto y no trae adjuntos');
  }
  if (params.body.length > MAX_MESSAGE_BODY_LEN) {
    throw new TicketMessageValidationError(`El mensaje supera el máximo de ${MAX_MESSAGE_BODY_LEN} caracteres`);
  }

  const commentId = randomUUID();
  const attachments: TicketCommentAttachment[] = [];
  const savedKeys: string[] = [];

  try {
    for (let i = 0; i < params.files.length; i++) {
      const file = params.files[i]!;
      const c = classified[i]!;
      const id = randomUUID();
      const storageKey = `tickets/${params.ticketId}/${commentId}/${id}.${c.ext}`;

      savedKeys.push(storageKey); // trackear ANTES del save (delete es idempotente)
      await fileStorage.save({ key: storageKey, buffer: file.buffer, mimeType: c.mimeType });

      attachments.push({
        id,
        commentId,
        url: null,
        storageKey,
        kind: c.kind,
        filename: file.originalName,
        mimeType: c.mimeType,
        sizeBytes: file.buffer.length,
      });
    }

    const comment: TicketComment = {
      id: commentId,
      ticketId: params.ticketId,
      authorId: params.authorId,
      authorKind: params.authorKind,
      visibility: params.visibility,
      authorName: params.authorName,
      body: params.body,
      createdAt: new Date().toISOString(),
      attachments,
    };
    return await comments.create(comment);
  } catch (err) {
    const results = await Promise.allSettled(savedKeys.map((k) => fileStorage.delete(k)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        logger.warn(
          `[createTicketMessageWithAttachments] compensation failed to delete storage key "${savedKeys[i]}" (orphan left behind): ${String(r.reason)}`,
        );
      }
    });
    throw err;
  }
}
