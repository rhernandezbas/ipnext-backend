import { randomUUID } from 'crypto';
import { FileStorage } from '@domain/ports/FileStorage';
import { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import { TicketComment, TicketCommentAttachment, TicketCommentAttachmentKind, TicketCommentAuthorKind, TicketCommentVisibility } from '@domain/entities/ticketComment';
import { DomainError } from '@domain/errors';
import {
  TicketMessageValidationError,
  UnsupportedTicketMessageAttachmentTypeError,
  TicketMessageAttachmentTooLargeError,
  TooManyTicketMessageAttachmentsError,
  TicketMessageStorageUnavailableError,
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
// G8 (fix wave FINAL) — exportados para el test de invariante
// (`Object.keys(MAGIC_BYTE_SNIFFERS) ⊇ allowlist`): hoy, agregar un mimeType
// a la allowlist SIN agregarle también su sniffer de magic bytes da un 415
// silencioso en runtime (`matchesMagicBytes` devuelve `false` para cualquier
// mimeType sin entrada en `MAGIC_BYTE_SNIFFERS`) y nada se pone rojo — el test
// dedicado (`ticketMessageAttachments.snifferCoverage.test.ts`) cierra eso.
export const IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
export const AUDIO_MIME_TO_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'weba',
  'audio/x-m4a': 'm4a',
};
export const VIDEO_MIME_TO_EXT: Record<string, string> = {
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

/**
 * F4 (fix wave) — sniffing de magic bytes del CONTENIDO REAL, para cada uno de
 * los 16 mimeTypes de la allowlist (`IMAGE/AUDIO/VIDEO_MIME_TO_EXT` arriba).
 * Antes de esto, `classify()` solo miraba el `mimeType` DECLARADO por el
 * cliente (el `Content-Type` de la parte multipart) — un ejecutable PE
 * (`MZ...`) con `filename: payload.jpg` + `Content-Type: image/jpeg` pasaba
 * limpio y quedaba guardado en MinIO con 201.
 *
 * Firmas usadas (primeros bytes, salvo donde se indica offset):
 *   JPEG            FF D8 FF
 *   PNG             89 50 4E 47
 *   GIF             "GIF87a" / "GIF89a"
 *   WEBP            "RIFF" (offset 0) + "WEBP" (offset 8) — contenedor RIFF
 *   MP3             "ID3" (offset 0) o frame-sync MPEG (11 bits en 1: FF Ex-Fx)
 *   AAC (ADTS)      frame-sync ADTS (FF F1 / FF F9) o "ADIF"
 *   OGG             "OggS"
 *   WAV/x-wav       "RIFF" (offset 0) + "WAVE" (offset 8)
 *   WEBM (audio/video) EBML: 1A 45 DF A3
 *   MP4/MOV/M4A/3GP "ftyp" en offset 4 — familia ISO base media (los cuatro
 *                   contenedores comparten esta caja; no vale la pena
 *                   distinguir el brand exacto acá, ver nota abajo)
 *
 * MP4/MOV/M4A/3GP comparten el mismo sniffer (`isIsoBaseMediaContainer`) a
 * propósito: los cuatro son ISO Base Media File Format con distinto "brand"
 * (mp42/isom/qt  /3gp4/M4A ...) — validar el brand exacto sería frágil (hay
 * decenas de brands válidos según el encoder) y no aporta seguridad real: lo
 * que este chequeo previene es "esto no es NINGÚN contenedor multimedia
 * conocido", no "el brand exacto coincide con la extensión". El `mimeType`
 * declarado sigue siendo la fuente de la extensión/kind con la que se guarda.
 */
function hasPrefixBytes(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

function hasAsciiAt(buf: Buffer, offset: number, ascii: string): boolean {
  if (buf.length < offset + ascii.length) return false;
  return buf.toString('ascii', offset, offset + ascii.length) === ascii;
}

function isIsoBaseMediaContainer(buf: Buffer): boolean {
  return hasAsciiAt(buf, 4, 'ftyp');
}

function isRiffContainer(buf: Buffer, subtype: string): boolean {
  return hasAsciiAt(buf, 0, 'RIFF') && hasAsciiAt(buf, 8, subtype);
}

function isEbml(buf: Buffer): boolean {
  return hasPrefixBytes(buf, [0x1a, 0x45, 0xdf, 0xa3]);
}

function isMp3(buf: Buffer): boolean {
  if (hasAsciiAt(buf, 0, 'ID3')) return true;
  // Frame sync MPEG: los 11 bits iniciales en 1 (mask 0xFFE0 sobre 2 bytes).
  return buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0;
}

function isAdts(buf: Buffer): boolean {
  if (hasAsciiAt(buf, 0, 'ADIF')) return true;
  // Frame sync ADTS: FF Fx con los bits de MPEG-version/layer en 0 (mask 0xFFF6).
  return buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xf6) === 0xf0;
}

export const MAGIC_BYTE_SNIFFERS: Record<string, (buf: Buffer) => boolean> = {
  'image/jpeg': (b) => hasPrefixBytes(b, [0xff, 0xd8, 0xff]),
  'image/png': (b) => hasPrefixBytes(b, [0x89, 0x50, 0x4e, 0x47]),
  'image/gif': (b) => hasAsciiAt(b, 0, 'GIF87a') || hasAsciiAt(b, 0, 'GIF89a'),
  'image/webp': (b) => isRiffContainer(b, 'WEBP'),
  'audio/mpeg': isMp3,
  'audio/mp4': isIsoBaseMediaContainer,
  'audio/x-m4a': isIsoBaseMediaContainer,
  'audio/aac': isAdts,
  'audio/ogg': (b) => hasAsciiAt(b, 0, 'OggS'),
  'audio/wav': (b) => isRiffContainer(b, 'WAVE'),
  'audio/x-wav': (b) => isRiffContainer(b, 'WAVE'),
  'audio/webm': isEbml,
  'video/mp4': isIsoBaseMediaContainer,
  'video/quicktime': isIsoBaseMediaContainer,
  'video/webm': isEbml,
  'video/3gpp': isIsoBaseMediaContainer,
};

/** true si el CONTENIDO REAL del buffer matchea la firma del `mimeType` declarado. */
function matchesMagicBytes(mimeType: string, buffer: Buffer): boolean {
  const sniff = MAGIC_BYTE_SNIFFERS[mimeType];
  return sniff !== undefined && sniff(buffer);
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
    // F10 (fix wave, documentación) — un archivo de 0 bytes reporta el mismo
    // 415 "tipo no soportado" que un mimeType fuera de la allowlist, A
    // PROPÓSITO: 0 bytes no es un tamaño válido de NINGÚN formato permitido
    // (ni siquiera el JPEG/PNG/etc. más chico posible pesa 0), así que "tipo
    // no soportado" es honesto — no hay un `TicketMessageAttachmentTooLargeError`
    // "al revés" que tenga más sentido acá. Corre ANTES del magic-byte sniffing
    // de F4 (un buffer vacío no matchea ninguna firma de todos modos, pero el
    // mensaje de error específico de "vacío" es más claro que el genérico).
    if (!(file.buffer.length > 0)) {
      throw new UnsupportedTicketMessageAttachmentTypeError(file.mimeType);
    }
    const c = classify(file.mimeType);
    if (!c) throw new UnsupportedTicketMessageAttachmentTypeError(file.mimeType);
    // F4 (fix wave) — el mimeType declarado ya está en la allowlist (arriba),
    // pero eso solo prueba lo que el CLIENTE dijo. Confirmar contra el
    // contenido real evita el disfraz (ejecutable con Content-Type: image/jpeg).
    if (!matchesMagicBytes(file.mimeType, file.buffer)) {
      throw new UnsupportedTicketMessageAttachmentTypeError(file.mimeType);
    }
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
      try {
        await fileStorage.save({ key: storageKey, buffer: file.buffer, mimeType: c.mimeType });
      } catch (storageErr) {
        // F11 (fix wave) — un error YA tipado (ej. `StorageNotConfiguredError`)
        // pasa tal cual (ya tiene su propio código/status). Cualquier OTRA cosa
        // (ECONNREFUSED, timeout — MinIO caído/inalcanzable) se envuelve en
        // `TicketMessageStorageUnavailableError` (503) en vez de llegar cruda
        // al errorHandler, que la mandaría al 500 genérico. El catch de abajo
        // sigue haciendo la compensación con el error que sea.
        throw storageErr instanceof DomainError
          ? storageErr
          : new TicketMessageStorageUnavailableError(String((storageErr as Error)?.message ?? storageErr));
      }

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
