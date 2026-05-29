import { Router, Request, Response, NextFunction } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { UpdateIngestConfigSchema } from '@application/dto/gestionRealIngest.dto';
import { GetIngestConfig } from '@application/use-cases/GetIngestConfig';
import { UpdateIngestConfig } from '@application/use-cases/UpdateIngestConfig';
import { GetIngestStatus } from '@application/use-cases/GetIngestStatus';
import { ListNeedsReviewTasks } from '@application/use-cases/ListNeedsReviewTasks';

/**
 * Gestión Real installation-ingest admin routes.
 *
 * - `GET  /config`       → current ingest config DTO (REQ-GETCFG-1)
 * - `PUT  /config`       → update config; 400 VALIDATION_ERROR on bad body,
 *                          404 PROJECT_NOT_FOUND on a ghost project FK (REQ-PUTCFG-1/2)
 * - `GET  /status`       → last run timestamp + counts (REQ-STATUS-1)
 * - `GET  /needs-review` → unclassified needs-review task DTOs (REQ-REVIEW-1)
 *
 * Body-shape validation is done inline via Zod (the repo's `safeParse` →
 * 400 VALIDATION_ERROR convention). Domain errors (PROJECT_NOT_FOUND) are
 * thrown by the use-case and translated by the global `errorHandler` middleware.
 */
export function createGestionRealIngestRouter(
  authProvider: AuthProvider,
  getIngestConfig: GetIngestConfig,
  updateIngestConfig: UpdateIngestConfig,
  getIngestStatus: GetIngestStatus,
  listNeedsReviewTasks: ListNeedsReviewTasks,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  router.get('/config', auth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getIngestConfig.execute());
    } catch (err) {
      next(err);
    }
  });

  router.put('/config', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateIngestConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      // Domain errors (e.g. PROJECT_NOT_FOUND → 404) bubble to the global handler.
      res.json(await updateIngestConfig.execute(parsed.data));
    } catch (err) {
      next(err);
    }
  });

  router.get('/status', auth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getIngestStatus.execute());
    } catch (err) {
      next(err);
    }
  });

  router.get('/needs-review', auth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await listNeedsReviewTasks.execute());
    } catch (err) {
      next(err);
    }
  });

  return router;
}
