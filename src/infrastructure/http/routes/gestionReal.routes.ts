import { Router, Request, Response, NextFunction } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import { GetGestionRealSyncStatus } from '@application/use-cases/GetGestionRealSyncStatus';

export function createGestionRealRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  getSyncStatus: GetGestionRealSyncStatus,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider, sessionRepo);

  router.get('/sync/status', auth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getSyncStatus.execute());
    } catch (err) {
      next(err);
    }
  });

  return router;
}
