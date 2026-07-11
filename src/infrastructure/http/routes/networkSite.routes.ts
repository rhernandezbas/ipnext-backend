import { Router, Request, Response, NextFunction } from 'express';
import { ListNetworkSites } from '@application/use-cases/ListNetworkSites';
import { ListNetworkSitesWithUisp } from '@application/use-cases/ListNetworkSitesWithUisp';
import { GetNetworkSite } from '@application/use-cases/GetNetworkSite';
import { CreateNetworkSite } from '@application/use-cases/CreateNetworkSite';
import { UpdateNetworkSite } from '@application/use-cases/UpdateNetworkSite';
import { DeleteNetworkSite } from '@application/use-cases/DeleteNetworkSite';
import { AssignIClassNodeToNetworkSite } from '@application/use-cases/AssignIClassNodeToNetworkSite';

export function createNetworkSiteRouter(
  listNetworkSites: ListNetworkSites,
  getNetworkSite: GetNetworkSite,
  createNetworkSite: CreateNetworkSite,
  updateNetworkSite: UpdateNetworkSite,
  deleteNetworkSite: DeleteNetworkSite,
  listNetworkSitesWithUisp?: ListNetworkSitesWithUisp,
  assignIClassNode?: AssignIClassNodeToNetworkSite,
): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (listNetworkSitesWithUisp) {
        const sites = await listNetworkSitesWithUisp.execute();
        res.json(sites);
      } else {
        const sites = await listNetworkSites.execute();
        res.json(sites);
      }
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const site = await createNetworkSite.execute(req.body);
      res.status(201).json(site);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const site = await getNetworkSite.execute(req.params['id'] as string);
      if (!site) {
        res.status(404).json({ error: 'Network site not found', code: 'NETWORK_SITE_NOT_FOUND' });
        return;
      }
      res.json(site);
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params['id'] as string;
      const body = (req.body ?? {}) as Record<string, unknown>;

      // nodes-city-mapper (#45): conditional delegation (pattern projects.routes PUT).
      // If `iclassNodeId` is explicitly present (including null), validate+assign via
      // AssignIClassNodeToNetworkSite (sets iclassNodeCode + city = node.code, or
      // clears iclassNodeCode on null). Remaining fields fall through to updateNetworkSite.
      if ('iclassNodeId' in body && assignIClassNode !== undefined) {
        const { iclassNodeId, ...rest } = body;
        const assigned = await assignIClassNode.execute(id, (iclassNodeId as string | null) ?? null);
        if (!assigned) {
          res.status(404).json({ error: 'Network site not found', code: 'NETWORK_SITE_NOT_FOUND' });
          return;
        }
        // H1: the assignment is the source of truth for `city` and `iclassNodeCode`
        // (city = node.code on assign). A manual `city`/`iclassNodeCode` riding along
        // in the same body would clobber that derived value in the follow-up update —
        // so strip them. Any OTHER field (name, status, …) still falls through.
        delete (rest as Record<string, unknown>)['city'];
        delete (rest as Record<string, unknown>)['iclassNodeCode'];
        if (Object.keys(rest).length === 0) {
          res.json(assigned);
          return;
        }
        const updated = await updateNetworkSite.execute(id, rest);
        res.json(updated ?? assigned);
        return;
      }

      const site = await updateNetworkSite.execute(id, body);
      if (!site) {
        res.status(404).json({ error: 'Network site not found', code: 'NETWORK_SITE_NOT_FOUND' });
        return;
      }
      res.json(site);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const deleted = await deleteNetworkSite.execute(req.params['id'] as string);
      if (!deleted) {
        res.status(404).json({ error: 'Network site not found', code: 'NETWORK_SITE_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
