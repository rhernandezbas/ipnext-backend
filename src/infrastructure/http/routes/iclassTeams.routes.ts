import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { SyncIClassTeams } from '@application/use-cases/SyncIClassTeams';
import { ListIClassTeams } from '@application/use-cases/ListIClassTeams';
import { toIClassTeamDTO } from '@application/dto/iclassTeam.dto';

/**
 * Admin routes for the IClass team catalog.
 *
 *   GET   /teams       — list catalog entries (gate: iclass.read)
 *   POST  /teams/sync  — sync from IClass (gate: iclass.manage)
 *
 * Mount at /api/admin/iclass (same base as status + closure routers).
 * POST /teams/sync MUST be registered BEFORE GET /teams to avoid route shadowing.
 *
 * Clone of iclassStatuses.routes.ts for teams.
 */
export function createIClassTeamsRouter(
  syncIClassTeams: SyncIClassTeams,
  listIClassTeams: ListIClassTeams,
  authProvider: AuthProvider,
  requireIClassRead: RequestHandler,
  requireIClassManage: RequestHandler,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  // POST /teams/sync — manual sync of team catalog (iclass.manage)
  // MUST be registered BEFORE /teams (no :id catch-all here, but order is consistent)
  router.post('/teams/sync', auth, requireIClassManage, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await syncIClassTeams.execute();
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /teams — list the team catalog (iclass.read)
  router.get('/teams', auth, requireIClassRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const teams = await listIClassTeams.execute();
      res.status(200).json({ items: teams.map(toIClassTeamDTO) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
