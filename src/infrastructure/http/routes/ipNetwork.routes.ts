import { Router, Request, Response } from 'express';
import { ListIpNetworks } from '@application/use-cases/ListIpNetworks';
import { CreateIpNetwork } from '@application/use-cases/CreateIpNetwork';
import { DeleteIpNetwork } from '@application/use-cases/DeleteIpNetwork';
import { ListIpPools } from '@application/use-cases/ListIpPools';
import { CreateIpPool } from '@application/use-cases/CreateIpPool';
import { ListIpAssignments } from '@application/use-cases/ListIpAssignments';
import { DeleteIpPool } from '@application/use-cases/DeleteIpPool';
import { ListIpv6Networks } from '@application/use-cases/ListIpv6Networks';
import { CreateIpv6Network } from '@application/use-cases/CreateIpv6Network';

export function createIpNetworkRouter(
  listIpNetworks: ListIpNetworks,
  createIpNetwork: CreateIpNetwork,
  deleteIpNetwork: DeleteIpNetwork,
  listIpPools: ListIpPools,
  createIpPool: CreateIpPool,
  listIpAssignments: ListIpAssignments,
  deleteIpPool?: DeleteIpPool,
  listIpv6Networks?: ListIpv6Networks,
  createIpv6Network?: CreateIpv6Network,
): Router {
  const router = Router();

  // IP Networks
  router.get('/ip-networks', async (_req: Request, res: Response): Promise<void> => {
    const networks = await listIpNetworks.execute();
    res.json(networks);
  });

  router.post('/ip-networks', async (req: Request, res: Response): Promise<void> => {
    const network = await createIpNetwork.execute(req.body);
    res.status(201).json(network);
  });

  router.delete('/ip-networks/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteIpNetwork.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'IP network not found', code: 'IP_NETWORK_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  // IP Pools
  router.get('/ip-pools', async (_req: Request, res: Response): Promise<void> => {
    const pools = await listIpPools.execute();
    res.json(pools);
  });

  router.post('/ip-pools', async (req: Request, res: Response): Promise<void> => {
    const pool = await createIpPool.execute(req.body);
    res.status(201).json(pool);
  });

  router.delete('/ip-pools/:id', async (req: Request, res: Response): Promise<void> => {
    if (!deleteIpPool) { res.status(501).json({ error: 'Not implemented' }); return; }
    const deleted = await deleteIpPool.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'IP pool not found', code: 'IP_POOL_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  // IP Assignments
  router.get('/ip-assignments', async (_req: Request, res: Response): Promise<void> => {
    const assignments = await listIpAssignments.execute();
    res.json(assignments);
  });

  // IPv6 Networks
  router.get('/ipv6-networks', async (_req: Request, res: Response): Promise<void> => {
    if (!listIpv6Networks) { res.json([]); return; }
    const networks = await listIpv6Networks.execute();
    res.json(networks);
  });

  router.post('/ipv6-networks', async (req: Request, res: Response): Promise<void> => {
    if (!createIpv6Network) { res.status(501).json({ error: 'Not implemented' }); return; }
    const network = await createIpv6Network.execute(req.body);
    res.status(201).json(network);
  });

  return router;
}
