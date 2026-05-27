import { Router, Request, Response } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { GetGestionRealSyncStatus } from '@application/use-cases/GetGestionRealSyncStatus';

export function createGestionRealRouter(
  authProvider: AuthProvider,
  getSyncStatus: GetGestionRealSyncStatus,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  router.get('/sync/status', auth, async (_req: Request, res: Response): Promise<void> => {
    res.json(await getSyncStatus.execute());
  });

  return router;
}
