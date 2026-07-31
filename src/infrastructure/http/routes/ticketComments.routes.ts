import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { ListTicketComments } from '@application/use-cases/ListTicketComments';
import { AddTicketComment } from '@application/use-cases/AddTicketComment';
import { AddTicketCommentSchema, toTicketCommentDto } from '@application/dto/ticketComments.dto';

/** Per-route permission guards (tickets read/write). */
export interface TicketCommentRoutePerms {
  read: RequestHandler;
  write: RequestHandler;
}

export function createTicketCommentsRouter(
  listComments: ListTicketComments,
  addComment: AddTicketComment,
  auth: RequestHandler,
  perms: TicketCommentRoutePerms,
): Router {
  const router = Router();

  // GET /api/tickets/:ticketId/comments
  router.get(
    '/:ticketId/comments',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const comments = await listComments.execute(req.params['ticketId'] as string);
        // F9 (fix wave) — DTO, no la entidad cruda (storageKey no debe viajar).
        res.json(comments.map(toTicketCommentDto));
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/tickets/:ticketId/comments
  router.post(
    '/:ticketId/comments',
    auth,
    perms.write,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const parsed = AddTicketCommentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({
          error: 'Validation error',
          code: 'VALIDATION_ERROR',
          details: parsed.error.issues,
        });
        return;
      }

      try {
        const data = parsed.data;
        const comment = await addComment.execute({
          ticketId: req.params['ticketId'] as string,
          body: data.body,
          authorName: data.authorName ?? req.user?.username ?? 'System',
          attachments: data.attachments,
        });
        // F9 (fix wave) — mismo criterio que el GET: DTO, no la entidad cruda.
        res.status(201).json(toTicketCommentDto(comment));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
