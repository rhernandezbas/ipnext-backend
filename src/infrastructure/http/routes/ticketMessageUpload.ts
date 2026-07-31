import multer from 'multer';
import type { RequestHandler } from 'express';
import {
  MAX_VIDEO_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TOTAL_BATCH_BYTES,
} from '@application/use-cases/ticketMessageAttachments';

/**
 * ticketMessageUpload — portal-ticket-messaging (v2.B). Middleware de subida
 * COMPARTIDO por la ruta del portal (`portal.routes.ts`) y la del staff
 * (`ticketMessages.routes.ts`) — mismo field name, mismos topes, misma
 * traducción de errores de multer a 4xx (molde `messaging.routes.ts`
 * `uploadAttachments` / `newsMedia.routes.ts` `uploadFiles`).
 *
 * El tope POR ARCHIVO de multer usa `MAX_VIDEO_BYTES` (el más grande de los
 * tres — imagen/audio son más chicos): es solo el primer filtro grueso: la
 * validación FINA por categoría (imagen ≤8MB, audio ≤15MB, video ≤40MB) la
 * hace `validateTicketMessageFilesBatch` en la capa de aplicación, que SÍ
 * conoce el mimetype de cada archivo.
 */
export const TICKET_MESSAGE_FILES_FIELD = 'files';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES, files: MAX_ATTACHMENTS_PER_MESSAGE },
});

export function createTicketMessageUploadMiddleware(): RequestHandler {
  return (req, res, next) => {
    upload.array(TICKET_MESSAGE_FILES_FIELD, MAX_ATTACHMENTS_PER_MESSAGE)(req, res, (err: unknown) => {
      if (!err) {
        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
        const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
        if (totalBytes > MAX_TOTAL_BATCH_BYTES) {
          res.status(413).json({
            error: `The combined size of all attachments exceeds the ${Math.floor(MAX_TOTAL_BATCH_BYTES / (1024 * 1024))}MB total batch limit`,
            code: 'BATCH_TOO_LARGE',
          });
          return;
        }
        next();
        return;
      }
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({
            error: `One of the files exceeds the ${Math.floor(MAX_VIDEO_BYTES / (1024 * 1024))}MB limit`,
            code: 'FILE_TOO_LARGE',
          });
          return;
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          res.status(400).json({
            error: `At most ${MAX_ATTACHMENTS_PER_MESSAGE} files are allowed under the "${TICKET_MESSAGE_FILES_FIELD}" field`,
            code: 'TOO_MANY_FILES',
          });
          return;
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          res.status(400).json({
            error: `Unexpected field — attachments must be sent under the "${TICKET_MESSAGE_FILES_FIELD}" field`,
            code: 'UNEXPECTED_FIELD',
          });
          return;
        }
        res.status(400).json({ error: err.message, code: 'UPLOAD_ERROR' });
        return;
      }
      next(err);
    });
  };
}
