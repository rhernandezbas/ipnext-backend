import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ListIClassNodeCatalog } from '@application/use-cases/ListIClassNodeCatalog';
import { ListIClassTeams } from '@application/use-cases/ListIClassTeams';
import { ListClients } from '@application/use-cases/ListClients';
import { GetClientContracts } from '@application/use-cases/GetClientContracts';
import { ListProjects } from '@application/use-cases/ListProjects';
import { ListNetworkSites } from '@application/use-cases/ListNetworkSites';
import { toIClassTeamDTO } from '@application/dto/iclassTeam.dto';
import { toClientDto } from '@application/dto/clients.dto';
import { toInternalContractDto } from '@application/dto/contract.dto';

const BoolQueryFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform(v => (v === 'true' ? true : v === 'false' ? false : undefined));

const ListCitiesQuerySchema = z.object({
  active: BoolQueryFlag,
});

// Unlike ListCitiesQuerySchema (no filter by default — the caller decides), /teams
// DEFAULTS to active=true when the query param is absent: the only consumer of this
// bridge is the assignment automation, which only ever wants assignable technicians
// (#134 — a cancelled/terminated login left selectable rejects every schedule slot
// IClass receives for it). Pass ?active=false explicitly to see deactivated teams.
const ListTeamsQuerySchema = z.object({
  active: BoolQueryFlag,
});

// Same coercion criterion as the rest of this router's numeric/boolean query params —
// zod coerce so `?page=2&limit=10` (always strings on req.query) parse cleanly.
const ListClientsQuerySchema = z.object({
  search: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

const ListProjectsQuerySchema = z.object({
  visible: BoolQueryFlag,
});

export interface InternalCatalogsDeps {
  listIClassNodeCatalog: ListIClassNodeCatalog;
  listIClassTeams: ListIClassTeams;
  listClients: ListClients;
  getContracts: GetClientContracts;
  listProjectsUC: ListProjects;
  listNetworkSites: ListNetworkSites;
}

/**
 * Purely internal, read-only catalog router — NO auth middleware, same explicit
 * product decision as internal-tasks.routes.ts (trusted internal automation only,
 * never exposed publicly). Reuses the SAME use-case instances wired for the
 * authenticated equivalents elsewhere in app.ts — no duplicated DI.
 *
 * GET /cities             — IClass node catalog (nodes ARE the cities in Prominense).
 * GET /teams              — IClass team catalog (technicians/cuadrillas). Defaults to
 *                            active=true (only assignable technicians); ?active=false
 *                            to see deactivated/cancelled logins too (#134).
 * GET /clients            — client search, to find WHO the task is for.
 * GET /clients/:id/contracts — a client's contracts, to pick WHICH one when there are several.
 * GET /projects           — project catalog, to pick the IClass SO type target.
 * GET /network-sites      — network site catalog, for kind='network' tasks.
 */
export function createInternalCatalogsRouter(deps: InternalCatalogsDeps): Router {
  const { listIClassNodeCatalog, listIClassTeams, listClients, getContracts, listProjectsUC, listNetworkSites } = deps;
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

  // GET /teams — same DTO/mapping as GET /api/admin/iclass/teams (iclassTeams.routes.ts),
  // but filtered to active=true by default (#134) — see ListTeamsQuerySchema above.
  router.get('/teams', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ListTeamsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }

      const active = parsed.data.active ?? true;
      const teams = await listIClassTeams.execute({ active });
      res.status(200).json({ items: teams.map(toIClassTeamDTO) });
    } catch (err) {
      next(err);
    }
  });

  // GET /clients?search=&page=&limit=&status= — client search, same allow-list DTO
  // and pagination shape as ListClients/PaginatedResult (no auth, internal bridge only).
  router.get('/clients', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ListClientsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }

      const { search, status, page, limit } = parsed.data;
      const result = await listClients.execute({ search, status, page, limit });

      res.status(200).json({
        items: result.data.map(toClientDto),
        total: result.total,
        page: result.page,
        limit: result.limit,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /clients/:id/contracts — ALL contracts for a client (no pagination, mirrors
  // GetClientContracts semantics), so the caller can pick the right one when there
  // are several. GetClientContracts.execute() returns [] for a non-existent/contract-less
  // client (never throws) — no explicit not-found catch needed here.
  router.get('/clients/:id/contracts', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const contracts = await getContracts.execute(req.params.id);
      res.status(200).json({ items: contracts.map(toInternalContractDto) });
    } catch (err) {
      next(err);
    }
  });

  // GET /projects?visible=true|false — same optional boolean-flag criterion as
  // ListNodesQuerySchema (iclass-admin.routes.ts). Returned AS-IS, same as the
  // authenticated GET /api/projects (projects.routes.ts) — Project is already a
  // domain entity assembled by the repo, not a raw Prisma row.
  router.get('/projects', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ListProjectsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }

      const filter = parsed.data.visible !== undefined ? { visible: parsed.data.visible } : undefined;
      const items = await listProjectsUC.execute(filter);

      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // GET /network-sites — simple (non-UISP-enriched) site catalog, enough to pick a
  // networkSiteId when creating a kind='network' task. Returned AS-IS (domain entity).
  router.get('/network-sites', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const items = await listNetworkSites.execute();
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
