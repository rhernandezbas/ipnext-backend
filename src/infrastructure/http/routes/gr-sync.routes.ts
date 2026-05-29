import { Router, Request, Response } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ResetGrClientsCursor } from '@application/use-cases/ResetGrClientsCursor';
import { ReconcileGrClients } from '@application/use-cases/ReconcileGrClients';

export function createGrSyncRouter(
  authProvider: AuthProvider,
  resetGrClientsCursor: ResetGrClientsCursor,
  reconcileGrClients?: ReconcileGrClients,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  // Clears the gr-clients watermark → next scheduler tick does a full backfill.
  router.post('/reset-clients-cursor', auth, async (_req: Request, res: Response, next): Promise<void> => {
    try {
      const result = await resetGrClientsCursor.execute();
      res.json({ ...result, message: 'next sync will backfill all clients' });
    } catch (err) {
      next(err);
    }
  });

  // Read-only diagnostic: full-universe GR vs. local mirror set-diff.
  // 503 when GR is not configured (the collaborator is only wired then).
  router.post('/reconcile-report', auth, async (_req: Request, res: Response, next): Promise<void> => {
    try {
      if (!reconcileGrClients) {
        res.status(503).json({ error: 'Gestión Real is not configured' });
        return;
      }
      const report = await reconcileGrClients.execute();
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
