import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { GetIClassDispatchPreview } from '@application/use-cases/GetIClassDispatchPreview';
import { toDispatchPreviewRowDTO } from '@application/dto/iclassDispatchPreview.dto';

/**
 * Admin route for the IClass dispatch preview (Ola C — read-only).
 *
 *   GET /dispatch-preview  — preview of what gets sent to IClass per project (gate: iclass.read)
 *
 * Mount at /api/admin/iclass.
 */
export function createIClassDispatchPreviewRouter(
  getDispatchPreview: GetIClassDispatchPreview,
  authProvider: AuthProvider,
  requireIClassRead: RequestHandler,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  // GET /dispatch-preview — read-only, describes dispatch rules per project
  router.get('/dispatch-preview', auth, requireIClassRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { items } = await getDispatchPreview.execute();
      res.status(200).json({ items: items.map(toDispatchPreviewRowDTO) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
