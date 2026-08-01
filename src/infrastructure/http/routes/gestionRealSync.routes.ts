import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import { UpdateSyncConfigSchema } from '@application/dto/gestionRealSync.dto';
import { GetSyncConfig } from '@application/use-cases/GetSyncConfig';
import { UpdateSyncConfig } from '@application/use-cases/UpdateSyncConfig';
import { GetGestionRealSyncStatus } from '@application/use-cases/GetGestionRealSyncStatus';
import { ResetGrClientsCursor } from '@application/use-cases/ResetGrClientsCursor';
import { ResyncAllGr } from '@application/use-cases/ResyncAllGr';

/** Factory matching `requirePerm` exported from app.ts (kept injectable so the router stays decoupled from the app singletons). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/**
 * Gestión Real client-sync admin routes (RBAC-guarded).
 *
 * - `GET /config`      → current sync config DTO (REQ-GETCFG-1)   [gestionReal:read]
 * - `PUT /config`      → update config; 400 VALIDATION_ERROR on bad body (REQ-PUTCFG-1/2) [gestionReal:write]
 * - `GET /status`      → existing GR sync status view (REQ-STATUS-1) [gestionReal:read]
 * - `POST /resync-all` → reset clients cursor + arm contract backfill (REQ-RESYNCALL-1) [gestionReal:write]
 * - `POST /reset`      → clear only the gr-clients cursor (clients-only re-backfill) (REQ-RESET-1) [gestionReal:write]
 *
 * Middleware order per route: `auth` (populates req.user) → `requirePerm` (reads
 * req.user.id) → handler. Body-shape validation is inline via Zod (repo's
 * `safeParse` → 400 VALIDATION_ERROR convention). All responses are DTOs.
 */
export function createGestionRealSyncRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
  getSyncConfig: GetSyncConfig,
  updateSyncConfig: UpdateSyncConfig,
  getSyncStatus: GetGestionRealSyncStatus,
  resetGrClientsCursor: ResetGrClientsCursor,
  resyncAllGr: ResyncAllGr,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider, sessionRepo);

  router.get(
    '/config',
    auth,
    requirePerm('gestionReal', 'read'),
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        res.json(await getSyncConfig.execute());
      } catch (err) {
        next(err);
      }
    },
  );

  router.put(
    '/config',
    auth,
    requirePerm('gestionReal', 'write'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const parsed = UpdateSyncConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        res.json(await updateSyncConfig.execute(parsed.data));
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/status',
    auth,
    requirePerm('gestionReal', 'read'),
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        res.json(await getSyncStatus.execute());
      } catch (err) {
        next(err);
      }
    },
  );

  // Re-sincronizar todo: reset the client cursor AND arm the contract backfill.
  router.post(
    '/resync-all',
    auth,
    requirePerm('gestionReal', 'write'),
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const result = await resyncAllGr.execute();
        res.json({ ...result, message: 'next ticks will re-backfill all clients and their contracts' });
      } catch (err) {
        next(err);
      }
    },
  );

  // Clients-only reset (kept, back-compat): just re-backfill clients next tick.
  router.post(
    '/reset',
    auth,
    requirePerm('gestionReal', 'write'),
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const result = await resetGrClientsCursor.execute();
        res.json({ ...result, message: 'next sync will backfill all clients' });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
