import { Router, Request, Response } from 'express';
import { ListNetworkSites } from '@application/use-cases/ListNetworkSites';
import { GetNetworkSite } from '@application/use-cases/GetNetworkSite';
import { CreateNetworkSite } from '@application/use-cases/CreateNetworkSite';
import { UpdateNetworkSite } from '@application/use-cases/UpdateNetworkSite';
import { DeleteNetworkSite } from '@application/use-cases/DeleteNetworkSite';

export function createNetworkSiteRouter(
  listNetworkSites: ListNetworkSites,
  getNetworkSite: GetNetworkSite,
  createNetworkSite: CreateNetworkSite,
  updateNetworkSite: UpdateNetworkSite,
  deleteNetworkSite: DeleteNetworkSite,
): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    const sites = await listNetworkSites.execute();
    res.json(sites);
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const site = await createNetworkSite.execute(req.body);
    res.status(201).json(site);
  });

  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const site = await getNetworkSite.execute(req.params['id'] as string);
    if (!site) {
      res.status(404).json({ error: 'Network site not found', code: 'NETWORK_SITE_NOT_FOUND' });
      return;
    }
    res.json(site);
  });

  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    const site = await updateNetworkSite.execute(req.params['id'] as string, req.body);
    if (!site) {
      res.status(404).json({ error: 'Network site not found', code: 'NETWORK_SITE_NOT_FOUND' });
      return;
    }
    res.json(site);
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteNetworkSite.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Network site not found', code: 'NETWORK_SITE_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
