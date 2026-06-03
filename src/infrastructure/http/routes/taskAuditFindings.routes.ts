import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { ListTaskAuditFindings } from '@application/use-cases/ListTaskAuditFindings';

/**
 * AI installation-audit read surface. Mounted at `/api` BEFORE the
 * `/api/scheduling/:id` catch-all. Auth + granular `requirePerm('scheduling','read')`.
 */
export function createTaskAuditFindingsRouter(
  listFindings: ListTaskAuditFindings,
  auth: RequestHandler,
  requireRead: RequestHandler,
): Router {
  const router = Router();
  router.get('/scheduling/:taskId/audit-findings', auth, requireRead, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await listFindings.execute(req.params.taskId));
    } catch (e) {
      next(e);
    }
  });
  return router;
}
