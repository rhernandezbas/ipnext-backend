/**
 * sessions.routes.ts — active session management (SDD #5 Phase 3) + history (SDD sessions-history).
 *
 * Mounted at /api/admin/sessions:
 *   GET  /history                      — list revoked sessions (admin.view_sessions)
 *   GET  /                             — list active sessions  (admin.view_sessions)
 *   POST /:id/revoke                   — revoke one session    (admin.revoke_sessions)
 *   POST /user/:userId/revoke-all      — revoke all of a user  (admin.revoke_sessions)
 *
 * IMPORTANT: GET /history is registered BEFORE any /:id catch-all routes.
 *
 * Guards are injected (DIP-clean): the router doesn't import requirePermission.
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import type { ListActiveSessions } from '@application/use-cases/sessions/ListActiveSessions';
import type { RevokeSession } from '@application/use-cases/sessions/RevokeSession';
import type { RevokeAllSessionsForUser } from '@application/use-cases/sessions/RevokeAllSessionsForUser';
import type { ListSessionHistory } from '@application/use-cases/sessions/ListSessionHistory';

export function createSessionsRouter(
  listActive: ListActiveSessions,
  revokeSession: RevokeSession,
  revokeAll: RevokeAllSessionsForUser,
  listHistory: ListSessionHistory,
  requireView: RequestHandler,
  requireRevoke: RequestHandler,
): Router {
  const router = Router();

  // GET /history — revoked sessions, paginated, ordered revokedAt DESC
  // MUST be declared BEFORE any /:id catch-all patterns.
  router.get('/history', requireView, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const page = req.query['page'] ? Number(req.query['page']) : 1;
      const pageSize = req.query['pageSize'] ? Number(req.query['pageSize']) : 20;

      if (pageSize > 100) {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'pageSize máximo es 100' });
        return;
      }

      const result = await listHistory.execute({ page, pageSize });
      res.json({ data: result.items, total: result.total, page: result.page, pageSize: result.pageSize });
    } catch (err) {
      next(err);
    }
  });

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
