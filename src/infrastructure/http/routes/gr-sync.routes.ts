import { Router, Request, Response } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ResetGrClientsCursor } from '@application/use-cases/ResetGrClientsCursor';

export function createGrSyncRouter(
  authProvider: AuthProvider,
  resetGrClientsCursor: ResetGrClientsCursor,
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

  return router;
}
