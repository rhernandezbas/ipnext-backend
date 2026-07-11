import { Router, Request, Response, RequestHandler, NextFunction } from 'express';
import { z } from 'zod';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListFeatureFlags } from '@application/use-cases/ListFeatureFlags';
import { GetFeatureFlag } from '@application/use-cases/GetFeatureFlag';
import { SetFeatureFlag } from '@application/use-cases/SetFeatureFlag';

const SetFeatureFlagSchema = z.object({ enabled: z.boolean() });

export function createFeatureFlagsRouter(
  authProvider: AuthProvider,
  listFeatureFlags: ListFeatureFlags,
  getFeatureFlag: GetFeatureFlag,
  setFeatureFlag: SetFeatureFlag,
  /** Permission guard for PATCH /:key — requires admin.flags. GETs remain auth-only. */
  requireFlags: RequestHandler,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  router.get('/', auth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await listFeatureFlags.execute());
    } catch (err) {
      next(err);
    }
  });

  router.get('/:key', auth, async (req: Request, res: Response, next): Promise<void> => {
    try {
      res.json(await getFeatureFlag.execute(req.params['key'] as string));
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:key', auth, requireFlags, async (req: Request, res: Response, next): Promise<void> => {
    const parsed = SetFeatureFlagSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await setFeatureFlag.execute(req.params['key'] as string, parsed.data.enabled));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
