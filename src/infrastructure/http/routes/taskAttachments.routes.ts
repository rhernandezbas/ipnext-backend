import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import multer from 'multer';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import { AttachPhotosToTask } from '@application/use-cases/AttachPhotosToTask';
import { ListTaskAttachments } from '@application/use-cases/ListTaskAttachments';
import { GetTaskAttachmentFile } from '@application/use-cases/GetTaskAttachmentFile';
import { DeleteTaskAttachment } from '@application/use-cases/DeleteTaskAttachment';
import { TaskNotFoundError } from '@domain/errors/scheduling';
import {
  UnsupportedAttachmentTypeError,
  TooManyAttachmentsError,
  AttachmentNotFoundError,
} from '@domain/errors/taskAttachment';
import { createAuthMiddleware } from '../middleware/authMiddleware';

/** 10 MiB por archivo, 15 archivos por request (alineado con el cupo de negocio). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 15;
const PHOTOS_FIELD = 'photos';

/**
 * Construye un header `Content-Disposition: inline` seguro (RFC 5987).
 *
 * Un filename con emoji/CJK/CRLF en el `filename="…"` crudo rompe el header y tira
 * `ERR_INVALID_CHAR` → 500 persistente. Solución: `filename="<ascii-fallback>"` (todo
 * lo no-ASCII y los caracteres peligrosos → `_`) + `filename*=UTF-8''<percent-encoded>`
 * con el nombre real. Se mantiene `inline` (la galería del FE lo necesita).
 */
function contentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface TaskAttachmentUseCases {
  attachPhotosToTask: AttachPhotosToTask;
  listTaskAttachments: ListTaskAttachments;
  getTaskAttachmentFile: GetTaskAttachmentFile;
  deleteTaskAttachment: DeleteTaskAttachment;
}

export interface TaskAttachmentRouterDeps {
  authProvider: AuthProvider;
  /**
   * fix/auth-stateful-routers — staff SessionRepository for STATEFUL auth: without
   * it, `createAuthMiddleware` degrades to the legacy stateless JWT-only check and a
   * REVOKED staff session keeps operating this router until the JWT expires.
   * The KEY is required (a caller can't silently forget it), but the value may be
   * `undefined` — matching the `SessionRepository | undefined` convention used by
   * every positional-style router this same change touched. app.ts always supplies
   * the real production `sessionRepo` here; `undefined` only shows up in test
   * fixtures unrelated to session semantics.
   */
  sessionRepo: SessionRepository | undefined;
  /** Gate de LECTURA de scheduling (requirePerm('scheduling','read')). */
  requireRead: RequestHandler;
  /** Gate de ESCRITURA de scheduling (requirePerm('scheduling','write')). */
  requireWrite: RequestHandler;
}

/**
 * Sub-router de adjuntos (fotos) de tarea. Se monta en `/api/scheduling`.
 *
 * Sobre el ORDEN (de montaje y de registro): NO es estructuralmente necesario — NO hay
 * shadowing real. Los paths son DISJUNTOS por cantidad de segmentos:
 * `/attachments/:id/file` (3), `/:taskId/attachments` (2) y el catch-all `GET /:id` del
 * scheduling router principal (1). Express nunca los confunde entre sí, sea cual sea el
 * orden. Se conserva el orden actual (literales `/attachments/...` antes que `/:taskId/...`,
 * y este router antes del principal) por CLARIDAD y convención del repo, no por necesidad.
 *
 * Contrato HTTP:
 *  - POST   /api/scheduling/:taskId/attachments   (write)  multipart 'photos' → 201 DTO[]
 *  - GET    /api/scheduling/:taskId/attachments   (read)   → 200 DTO[]
 *  - GET    /api/scheduling/attachments/:id/file  (read)   ?variant=thumb|original → binario
 *  - DELETE /api/scheduling/attachments/:id       (write)  → 204
 */
export function createTaskAttachmentsRouter(
  useCases: TaskAttachmentUseCases,
  deps: TaskAttachmentRouterDeps,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(deps.authProvider, deps.sessionRepo);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  });

  // Wrapper de multer que traduce sus errores de límite a 4xx claros (nunca 500).
  const uploadPhotos: RequestHandler = (req, res, next) => {
    upload.array(PHOTOS_FIELD, MAX_FILES)(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'One of the files exceeds the 10MB limit', code: 'FILE_TOO_LARGE' });
          return;
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
          res.status(400).json({ error: `At most ${MAX_FILES} files are allowed under the "photos" field`, code: 'TOO_MANY_FILES' });
          return;
        }
        res.status(400).json({ error: err.message, code: 'UPLOAD_ERROR' });
        return;
      }
      next(err);
    });
  };

  // ── /attachments/:id/* — registradas PRIMERO (evitan que :taskId capture "attachments") ──

  // GET /api/scheduling/attachments/:id/file?variant=thumb|original
  router.get('/attachments/:id/file', auth, deps.requireRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const variant = req.query['variant'] === 'thumb' ? 'thumb' : 'original';
    try {
      const file = await useCases.getTaskAttachmentFile.execute({
        attachmentId: req.params['id'] as string,
        variant,
      });
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Disposition', contentDisposition(file.filename));
      res.send(file.buffer);
    } catch (err) {
      if (err instanceof AttachmentNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  // DELETE /api/scheduling/attachments/:id
  router.delete('/attachments/:id', auth, deps.requireWrite, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await useCases.deleteTaskAttachment.execute({ attachmentId: req.params['id'] as string });
      res.status(204).send();
    } catch (err) {
      if (err instanceof AttachmentNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  // ── /:taskId/attachments ──

  // POST /api/scheduling/:taskId/attachments  (multipart, field 'photos')
  router.post('/:taskId/attachments', auth, deps.requireWrite, uploadPhotos, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: 'No files uploaded under the "photos" field', code: 'NO_FILES' });
      return;
    }
    try {
      const dtos = await useCases.attachPhotosToTask.execute({
        taskId: req.params['taskId'] as string,
        uploadedById: req.user!.id,
        files: files.map((f) => ({
          buffer: f.buffer,
          originalName: f.originalname,
          mimeType: f.mimetype,
        })),
      });
      res.status(201).json(dtos);
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof UnsupportedAttachmentTypeError) {
        res.status(415).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof TooManyAttachmentsError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  // GET /api/scheduling/:taskId/attachments
  router.get('/:taskId/attachments', auth, deps.requireRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const dtos = await useCases.listTaskAttachments.execute({ taskId: req.params['taskId'] as string });
      res.json(dtos);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
