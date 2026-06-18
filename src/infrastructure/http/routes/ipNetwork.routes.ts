import { Router, Request, Response, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListIpNetworks } from '@application/use-cases/ListIpNetworks';
import { CreateIpNetwork } from '@application/use-cases/CreateIpNetwork';
import { DeleteIpNetwork } from '@application/use-cases/DeleteIpNetwork';
import { ListIpPools } from '@application/use-cases/ListIpPools';
import { CreateIpPool } from '@application/use-cases/CreateIpPool';
import { ListIpAssignments } from '@application/use-cases/ListIpAssignments';
import { DeleteIpPool } from '@application/use-cases/DeleteIpPool';
import { ListIpv6Networks } from '@application/use-cases/ListIpv6Networks';
import { CreateIpv6Network } from '@application/use-cases/CreateIpv6Network';

type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/**
 * Redes / pools / asignaciones de IP. Estaban montadas en /api SIN auth ni permiso (agujero;
 * fix `network-routes-guard`) — incluyendo data sensible (GET /ip-pools, GET /ip-assignments).
 * `network.read` para listar; `network.manage` para las mutaciones.
 */
export function createIpNetworkRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
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
  const auth      = createAuthMiddleware(authProvider, sessionRepo);
  const canRead   = requirePerm('network', 'read');
  const canManage = requirePerm('network', 'manage');

  // IP Networks
  router.get('/ip-networks', auth, canRead, async (_req: Request, res: Response): Promise<void> => {
    const networks = await listIpNetworks.execute();
    res.json(networks);
  });

  router.post('/ip-networks', auth, canManage, async (req: Request, res: Response): Promise<void> => {
    const network = await createIpNetwork.execute(req.body);
    res.status(201).json(network);
  });

  router.delete('/ip-networks/:id', auth, canManage, async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteIpNetwork.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'IP network not found', code: 'IP_NETWORK_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  // IP Pools
  router.get('/ip-pools', auth, canRead, async (_req: Request, res: Response): Promise<void> => {
    const pools = await listIpPools.execute();
    res.json(pools);
  });

  router.post('/ip-pools', auth, canManage, async (req: Request, res: Response): Promise<void> => {
    const pool = await createIpPool.execute(req.body);
    res.status(201).json(pool);
  });

  router.delete('/ip-pools/:id', auth, canManage, async (req: Request, res: Response): Promise<void> => {
    if (!deleteIpPool) { res.status(501).json({ error: 'Not implemented' }); return; }
    const deleted = await deleteIpPool.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'IP pool not found', code: 'IP_POOL_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  // IP Assignments
  router.get('/ip-assignments', auth, canRead, async (_req: Request, res: Response): Promise<void> => {
    const assignments = await listIpAssignments.execute();
    res.json(assignments);
  });

  // IPv6 Networks
  router.get('/ipv6-networks', auth, canRead, async (_req: Request, res: Response): Promise<void> => {
    if (!listIpv6Networks) { res.json([]); return; }
    const networks = await listIpv6Networks.execute();
    res.json(networks);
  });

  router.post('/ipv6-networks', auth, canManage, async (req: Request, res: Response): Promise<void> => {
    if (!createIpv6Network) { res.status(501).json({ error: 'Not implemented' }); return; }
    const network = await createIpv6Network.execute(req.body);
    res.status(201).json(network);
  });

  return router;
}
