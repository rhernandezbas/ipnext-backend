import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import multer from 'multer';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import { AttachFilesToNews } from '@application/use-cases/AttachFilesToNews';
import { AttachLinkToNews } from '@application/use-cases/AttachLinkToNews';
import { GetNewsAttachmentFile } from '@application/use-cases/GetNewsAttachmentFile';
import { DeleteNewsAttachment } from '@application/use-cases/DeleteNewsAttachment';
import { BroadcastNewsToNoc } from '@application/use-cases/BroadcastNewsToNoc';
import { AttachLinkBodySchema } from '@application/dto/newsAttachment.dto';
import { NewsPostNotFoundError } from '@domain/errors/news';
import {
  UnsupportedNewsAttachmentTypeError,
  TooManyNewsAttachmentsError,
  NewsAttachmentNotFoundError,
  InvalidLinkAttachmentError,
} from '@domain/errors/newsAttachment';
import { createAuthMiddleware } from '../middleware/authMiddleware';

/** 10 MiB por archivo, 20 archivos por request (alineado con el cupo de negocio). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 20;
const FILES_FIELD = 'files';

/**
 * Content-Disposition: inline seguro (RFC 5987) — molde taskAttachments.routes. Un filename
 * con emoji/CJK/CRLF rompe el header crudo → ERR_INVALID_CHAR (500). Fallback ASCII +
 * filename* percent-encoded.
 */
function contentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface NewsMediaUseCases {
  attachFilesToNews: AttachFilesToNews;
  attachLinkToNews: AttachLinkToNews;
  getNewsAttachmentFile: GetNewsAttachmentFile;
  deleteNewsAttachment: DeleteNewsAttachment;
  broadcastNewsToNoc: BroadcastNewsToNoc;
}

export interface NewsMediaRouterDeps {
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
  /** Gate de LECTURA de news (requirePerm('news','read')) — servir binarios. */
  requireRead: RequestHandler;
  /** Gate de GESTIÓN de news (requirePerm('news','manage')) — subir/borrar/difundir. */
  requireManage: RequestHandler;
}

/**
 * Sub-router de media + difusión de Noticias. Se monta en `/api/news`.
 *
 * Los paths son DISJUNTOS respecto del news router principal por método + nº de segmentos
 * (`/attachments/:id/file`=3, `/attachments/:id`=2, `/:id/attachments`=2, `/:id/broadcast`=2)
 * vs. los del principal (`GET /:id`=1, `PUT /:id`, `POST /:id/read`, `PUT /:id/archive`,
 * `DELETE /categories/:id`), así que Express nunca los confunde, sea cual sea el orden de
 * montaje. Se conserva la convención de literales `/attachments/...` antes que `/:id/...`.
 *
 * Contrato HTTP:
 *  - POST   /api/news/:id/attachments   (manage)  multipart 'files'  → 201 DTO[]
 *                                       (manage)  json {kind:'link',url,filename?} → 201 DTO
 *  - GET    /api/news/attachments/:id/file (read)  → binario inline
 *  - DELETE /api/news/attachments/:id   (manage)  → 204
 *  - POST   /api/news/:id/broadcast     (manage)  → 200 { sent, link }
 */
export function createNewsMediaRouter(
  useCases: NewsMediaUseCases,
  deps: NewsMediaRouterDeps,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(deps.authProvider, deps.sessionRepo);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  });

  // Wrapper de multer: traduce sus errores de límite a 4xx claros (nunca 500). En un request
  // JSON (link) no es multipart → multer llama next() sin tocar el body ya parseado por express.json.
  const uploadFiles: RequestHandler = (req, res, next) => {
    upload.array(FILES_FIELD, MAX_FILES)(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'One of the files exceeds the 10MB limit', code: 'FILE_TOO_LARGE' });
          return;
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
          res.status(400).json({ error: `At most ${MAX_FILES} files are allowed under the "files" field`, code: 'TOO_MANY_FILES' });
          return;
        }
        res.status(400).json({ error: err.message, code: 'UPLOAD_ERROR' });
        return;
      }
      next(err);
    });
  };

  // ── /attachments/:id/* — registradas PRIMERO ────────────────────────────────

  // GET /api/news/attachments/:id/file
  router.get('/attachments/:id/file', auth, deps.requireRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const file = await useCases.getNewsAttachmentFile.execute({ attachmentId: req.params['id'] as string });
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Disposition', contentDisposition(file.filename));
      res.send(file.buffer);
    } catch (err) {
      if (err instanceof NewsAttachmentNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  // DELETE /api/news/attachments/:id
  router.delete('/attachments/:id', auth, deps.requireManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await useCases.deleteNewsAttachment.execute({ attachmentId: req.params['id'] as string });
      res.status(204).send();
    } catch (err) {
      if (err instanceof NewsAttachmentNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  // ── /:id/attachments — multipart (binarios) O json {kind:'link'} ─────────────
  router.post('/:id/attachments', auth, deps.requireManage, uploadFiles, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const newsPostId = req.params['id'] as string;
    try {
      if (files.length > 0) {
        const dtos = await useCases.attachFilesToNews.execute({
          newsPostId,
          uploadedById: req.user!.id,
          files: files.map((f) => ({ buffer: f.buffer, originalName: f.originalname, mimeType: f.mimetype })),
        });
        res.status(201).json(dtos);
        return;
      }
      // sin archivos → ¿link? (body json)
      const body = (req.body ?? {}) as { kind?: string };
      if (body.kind === 'link') {
        // Guarda de TIPO del body ANTES del use case: un `url` no-string ({}, array, number)
        // reventaba con TypeError crudo en `.trim()` → 500. Zod lo corta en 400. El esquema
        // http(s) se sigue validando en el dominio → 422 INVALID_LINK_ATTACHMENT (ftp://…, etc.).
        const parsed = AttachLinkBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }
        const dto = await useCases.attachLinkToNews.execute({
          newsPostId,
          uploadedById: req.user!.id,
          url: parsed.data.url,
          filename: parsed.data.filename,
        });
        res.status(201).json(dto);
        return;
      }
      res.status(400).json({ error: 'No files uploaded and no link provided', code: 'NO_ATTACHMENT' });
    } catch (err) {
      if (err instanceof NewsPostNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof UnsupportedNewsAttachmentTypeError) {
        res.status(415).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof TooManyNewsAttachmentsError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof InvalidLinkAttachmentError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  // ── /:id/broadcast — difundir al NOC (WhatsApp) ──────────────────────────────
  // Errores tipados de N1 (NOC_BROADCAST_NOT_CONFIGURED → 503, EVOLUTION_API_ERROR → 502,
  // NOC_BROADCAST_LINK_BASE_MISSING → 422) bajan al errorHandler global vía next(err).
  router.post('/:id/broadcast', auth, deps.requireManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await useCases.broadcastNewsToNoc.execute(req.params['id'] as string, req.user!.id, req.user!.username);
      res.json(result);
    } catch (err) {
      if (err instanceof NewsPostNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  return router;
}
