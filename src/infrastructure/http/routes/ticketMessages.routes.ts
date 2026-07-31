import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { SendStaffTicketReply } from '@application/use-cases/SendStaffTicketReply';
import { GetTicketUnreadCount } from '@application/use-cases/GetTicketUnreadCount';
import { GetTicketMessageAttachmentFile } from '@application/use-cases/GetTicketMessageAttachmentFile';
import { SendStaffTicketReplySchema } from '@application/dto/ticketMessage.dto';
import { toTicketMessageDto } from '@application/dto/ticketMessage.dto';
import { createTicketMessageUploadMiddleware, TICKET_MESSAGE_FILES_FIELD } from './ticketMessageUpload';

/** Content-Disposition inline seguro (RFC 5987) — molde `newsMedia.routes.ts` `contentDisposition`. */
function contentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface TicketMessagesRouterUseCases {
  sendStaffTicketReply: SendStaffTicketReply;
  getTicketUnreadCount: GetTicketUnreadCount;
  getTicketMessageAttachmentFile: GetTicketMessageAttachmentFile;
}

/** Per-route permission guards (tickets read/write) — mismo módulo RBAC que `ticketComments.routes.ts`. */
export interface TicketMessagesRoutePerms {
  read: RequestHandler;
  write: RequestHandler;
}

/**
 * ticketMessages.routes — portal-ticket-messaging (v2.B), lado ADMIN.
 *
 * Se monta en `/api/tickets` (mismo prefijo que `ticketComments.routes.ts`,
 * el CRUD de notas internas). Paths DISJUNTOS por nº de segmentos, igual
 * criterio que `newsMedia.routes.ts`:
 *   - `POST /:ticketId/messages`                    = 2 segmentos
 *   - `GET  /:ticketId/messages/unread-count`        = 3 segmentos
 *   - `GET  /messages/attachments/:id/file`          = 4 segmentos (literal
 *     `messages` primero, nunca choca con `/:ticketId/...` de arriba)
 *
 * `POST /:ticketId/messages` SIEMPRE crea `visibility: public` (la respuesta
 * al cliente) — la nota interna sigue viviendo en `POST /:ticketId/comments`
 * (`ticketComments.routes.ts`, sin cambios de contrato). `SendStaffTicketReplySchema`
 * es `.strict()`: si el body trae `visibility`, 400 — nunca cambia el resultado.
 */
export function createTicketMessagesRouter(
  useCases: TicketMessagesRouterUseCases,
  auth: RequestHandler,
  perms: TicketMessagesRoutePerms,
): Router {
  const router = Router();
  const uploadFiles = createTicketMessageUploadMiddleware();

  // ── /messages/attachments/:id/file — PRIMERO (4 segmentos, literal) ─────────
  router.get(
    '/messages/attachments/:id/file',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const file = await useCases.getTicketMessageAttachmentFile.execute(req.params['id'] as string);
        res.setHeader('Content-Type', file.mimeType);
        res.setHeader('Content-Disposition', contentDisposition(file.filename));
        res.send(file.buffer);
      } catch (err) {
        // TicketMessageAttachmentNotFoundError (404) y cualquier otro DomainError
        // bajan al errorHandler global (statusMap ya los mapea — ver errorHandler.ts).
        next(err);
      }
    },
  );

  // GET /:ticketId/messages/unread-count
  router.get(
    '/:ticketId/messages/unread-count',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const unreadCount = await useCases.getTicketUnreadCount.execute(req.params['ticketId'] as string);
        res.status(200).json({ unreadCount });
      } catch (err) {
        // TicketNotFoundError (404) baja al errorHandler global.
        next(err);
      }
    },
  );

  // POST /:ticketId/messages — respuesta PÚBLICA del staff (multipart: body + files)
  router.post(
    '/:ticketId/messages',
    auth,
    perms.write,
    uploadFiles,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const parsed = SendStaffTicketReplySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      try {
        const comment = await useCases.sendStaffTicketReply.execute({
          ticketId: req.params['ticketId'] as string,
          authorId: req.user!.id,
          authorName: parsed.data.authorName ?? req.user?.username ?? 'System',
          body: parsed.data.body,
          files: files.map((f) => ({ buffer: f.buffer, originalName: f.originalname, mimeType: f.mimetype })),
        });
        res.status(201).json(toTicketMessageDto(comment));
      } catch (err) {
        // TicketNotFoundError (404), TicketMessageValidationError (400),
        // UnsupportedTicketMessageAttachmentTypeError (415),
        // TicketMessageAttachmentTooLargeError (413) y
        // TooManyTicketMessageAttachmentsError (422) bajan al errorHandler global.
        next(err);
      }
    },
  );

  return router;
}

// Re-exportado por conveniencia (tests de wiring) — mismo field name que el portal.
export { TICKET_MESSAGE_FILES_FIELD };
