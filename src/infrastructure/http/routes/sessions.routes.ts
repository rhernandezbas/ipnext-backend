/**
 * sessions.routes.ts — active session management (SDD #5 Phase 3).
 *
 * Mounted at /api/admin/sessions:
 *   GET  /                          — list active sessions (admin.view_sessions)
 *   POST /:id/revoke                — revoke one session   (admin.revoke_sessions)
 *   POST /user/:userId/revoke-all   — revoke all of a user (admin.revoke_sessions)
 *
 * Guards are injected (DIP-clean): the router doesn't import requirePermission.
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import type { ListActiveSessions } from '@application/use-cases/sessions/ListActiveSessions';
import type { RevokeSession } from '@application/use-cases/sessions/RevokeSession';
import type { RevokeAllSessionsForUser } from '@application/use-cases/sessions/RevokeAllSessionsForUser';

export function createSessionsRouter(
  listActive: ListActiveSessions,
  revokeSession: RevokeSession,
  revokeAll: RevokeAllSessionsForUser,
  requireView: RequestHandler,
  requireRevoke: RequestHandler,
): Router {
  const router = Router();

  // GET / — active sessions, paginated, filterable by rbacUserId
  router.get('/', requireView, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rbacUserId = typeof req.query['rbacUserId'] === 'string' ? req.query['rbacUserId'] : undefined;
      const page = req.query['page'] ? Number(req.query['page']) : undefined;
      const pageSize = req.query['pageSize'] ? Number(req.query['pageSize']) : undefined;
      const result = await listActive.execute({ rbacUserId, page, pageSize });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /user/:userId/revoke-all — registered before /:id/revoke (distinct shape, but explicit)
  router.post('/user/:userId/revoke-all', requireRevoke, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const revoked = await revokeAll.execute(req.params['userId'] as string);
      res.json({ revoked });
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/revoke — revoke a single session (404 SESSION_NOT_FOUND if unknown)
  router.post('/:id/revoke', requireRevoke, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await revokeSession.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
