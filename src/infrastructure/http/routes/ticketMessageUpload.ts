import multer from 'multer';
import type { RequestHandler } from 'express';
import {
  MAX_VIDEO_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TOTAL_BATCH_BYTES,
} from '@application/use-cases/ticketMessageAttachments';
import { createBoundedBatchStorage, BatchTooLargeStreamError } from './boundedBatchStorage';

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

/**
 * F3 (fix wave) — margen para el overhead de multipart alrededor del techo real
 * de negocio (boundaries, headers de cada parte, nombre de archivo, el campo
 * `body` de texto). No es cálculo exacto: alcanza con no rechazar un batch
 * legítimo justo al borde del límite.
 */
const CONTENT_LENGTH_SAFETY_MARGIN_BYTES = 64 * 1024;

/**
 * G3 (fix wave FINAL) — el precheck de `Content-Length` de abajo es un
 * fast-path (header presente y honesto/de más → 413 SIN leer un byte del
 * body), pero NO es la protección real: con `Transfer-Encoding: chunked` no
 * hay `Content-Length` (`Number(undefined)` = `NaN`) y el precheck se salta
 * enteramente — multer bufferea entonces hasta `MAX_VIDEO_BYTES *
 * MAX_ATTACHMENTS_PER_MESSAGE` (~200MB) ANTES de que el chequeo post-upload
 * de abajo corra. `createBoundedBatchStorage` cierra eso por CONSTRUCCIÓN:
 * cuenta los bytes reales que salen de cada stream (nunca un header) y aborta
 * apenas el acumulado del request supera el presupuesto — el pico de RAM
 * queda acotado sin importar qué diga (o no diga) `Content-Length`.
 */
const upload = multer({
  storage: createBoundedBatchStorage(MAX_TOTAL_BATCH_BYTES + CONTENT_LENGTH_SAFETY_MARGIN_BYTES),
  limits: { fileSize: MAX_VIDEO_BYTES, files: MAX_ATTACHMENTS_PER_MESSAGE },
});

function batchTooLargeResponse(): { error: string; code: 'BATCH_TOO_LARGE' } {
  return {
    error: `The combined size of all attachments exceeds the ${Math.floor(MAX_TOTAL_BATCH_BYTES / (1024 * 1024))}MB total batch limit`,
    code: 'BATCH_TOO_LARGE',
  };
}

export function createTicketMessageUploadMiddleware(): RequestHandler {
  return (req, res, next) => {
    // F3 (fix wave) — cortar por `Content-Length` ANTES de invocar
    // `upload.array`: sin esto, multer bufferea los archivos COMPLETOS (hasta
    // MAX_VIDEO_BYTES=40MB cada uno, hasta 5 = ~200MB) y RECIÉN DESPUÉS se
    // evalúa el tope de batch (60MB) — el rechazo llegaba después del peor
    // pico de RAM, no antes. Con el rate limiter (20 envíos/5min POR CUENTA,
    // sin serializar) varios requests concurrentes de la misma cuenta
    // multiplican ese pico a varios GB. Un Content-Length declarado por
    // encima del batch + margen nunca puede terminar en un batch válido —
    // rechazarlo acá evita bufferear un solo byte.
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_TOTAL_BATCH_BYTES + CONTENT_LENGTH_SAFETY_MARGIN_BYTES) {
      res.status(413).json(batchTooLargeResponse());
      return;
    }

    upload.array(TICKET_MESSAGE_FILES_FIELD, MAX_ATTACHMENTS_PER_MESSAGE)(req, res, (err: unknown) => {
      if (!err) {
        // Segunda línea de defensa: un Content-Length ausente/mentiroso (o un
        // batch que entra justo bajo el margen de arriba pero sigue superando
        // el tope real UNA VEZ sumados los tamaños reales) sigue cortando acá,
        // como antes.
        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
        const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
        if (totalBytes > MAX_TOTAL_BATCH_BYTES) {
          res.status(413).json(batchTooLargeResponse());
          return;
        }
        next();
        return;
      }
      // G3 (fix wave FINAL) — el corte real: el StorageEngine abortó a mitad
      // de stream porque el acumulado REAL del request superó el presupuesto,
      // sin haber consultado ningún header. Mismo 413/BATCH_TOO_LARGE que el
      // precheck de Content-Length, para que el cliente vea el mismo contrato
      // sin importar CUÁL de las dos líneas de defensa cortó.
      if (err instanceof BatchTooLargeStreamError) {
        res.status(413).json(batchTooLargeResponse());
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
