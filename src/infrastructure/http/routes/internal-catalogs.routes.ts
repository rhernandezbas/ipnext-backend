import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ListIClassNodeCatalog } from '@application/use-cases/ListIClassNodeCatalog';
import { ListIClassTeams } from '@application/use-cases/ListIClassTeams';
import { toIClassTeamDTO } from '@application/dto/iclassTeam.dto';

const BoolQueryFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform(v => (v === 'true' ? true : v === 'false' ? false : undefined));

const ListCitiesQuerySchema = z.object({
  active: BoolQueryFlag,
});

export interface InternalCatalogsDeps {
  listIClassNodeCatalog: ListIClassNodeCatalog;
  listIClassTeams: ListIClassTeams;
}

/**
 * Purely internal, read-only catalog router — NO auth middleware, same explicit
 * product decision as internal-tasks.routes.ts (trusted internal automation only,
 * never exposed publicly). Reuses the SAME use-case instances wired for the
 * authenticated /api/admin/iclass/{nodes,teams} routes — no duplicated DI.
 *
 * GET /cities — IClass node catalog (nodes ARE the cities in Prominense).
 * GET /teams  — IClass team catalog (technicians/cuadrillas).
 */
export function createInternalCatalogsRouter(deps: InternalCatalogsDeps): Router {
  const { listIClassNodeCatalog, listIClassTeams } = deps;
  const router = Router();

  // GET /cities — same optional ?active= filter criterion as GET /api/admin/iclass/nodes
  // (iclass-admin.routes.ts ListNodesQuerySchema), minus ?selectable (not needed here).
  router.get('/cities', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ListCitiesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }

      const filter = parsed.data.active !== undefined ? { active: parsed.data.active } : undefined;
      const nodes = await listIClassNodeCatalog.execute(filter);

      // Same wire shape as GET /api/admin/iclass/nodes: dates → ISO strings, no raw entity.
      const items = nodes.map(n => ({
        id: n.id,
        nodeId: n.nodeId,
        code: n.code,
        description: n.description,
        active: n.active,
        selectable: n.selectable,
        lastSyncedAt: n.lastSyncedAt instanceof Date ? n.lastSyncedAt.toISOString() : n.lastSyncedAt,
        createdAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : n.createdAt,
        updatedAt: n.updatedAt instanceof Date ? n.updatedAt.toISOString() : n.updatedAt,
      }));

      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // GET /teams — same DTO/mapping as GET /api/admin/iclass/teams (iclassTeams.routes.ts).
  router.get('/teams', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const teams = await listIClassTeams.execute();
      res.status(200).json({ items: teams.map(toIClassTeamDTO) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
