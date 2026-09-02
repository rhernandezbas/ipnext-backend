/**
 * external-bulk-messaging (D7.c, CONFIG-1..3) — `/api/messaging/config/external-bulk`
 * router. Molde EXACTO `taskStageConfig.routes.ts`: sesión (NO API key), gate
 * `messaging:read` para `GET`, `messaging:manage` para `PUT`. Respuesta FLAT
 * `{maxPerRequest, maxPerDay, updatedAt}` — SIN envelope `{data}` (D12, mismo
 * criterio que `taskStageConfig.routes.ts`'s `res.json({...recipient, ...transition})`).
 *
 * El toggle del kill-switch NO vive acá (D7.c): reusa
 * `PATCH /api/feature-flags/messaging-external-bulk-enabled` (gate `admin.flags`),
 * ya existente.
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import { GetExternalBulkConfig } from '@application/use-cases/messaging/GetExternalBulkConfig';
import { SetExternalBulkConfig } from '@application/use-cases/messaging/SetExternalBulkConfig';

export interface ExternalBulkMessagingConfigRoutePerms {
  /** GET / — messaging:read. */
  read: RequestHandler;
  /** PUT / — messaging:manage. */
  manage: RequestHandler;
}

export function createExternalBulkMessagingConfigRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  perms: ExternalBulkMessagingConfigRoutePerms,
  getExternalBulkConfig: GetExternalBulkConfig,
  setExternalBulkConfig: SetExternalBulkConfig,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider, sessionRepo);

  // ─── GET / — config vigente (CONFIG-1, read) ────────────────────────────────
  router.get('/', auth, perms.read, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getExternalBulkConfig.execute());
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT / — update de los topes (CONFIG-3, manage) ────────────────────────
  router.put('/', auth, perms.manage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await setExternalBulkConfig.execute({
        maxPerRequest: body['maxPerRequest'],
        maxPerDay: body['maxPerDay'],
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
