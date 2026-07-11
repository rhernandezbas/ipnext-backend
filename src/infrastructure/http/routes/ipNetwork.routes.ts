import { Router, Request, Response, RequestHandler, NextFunction } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListIpNetworks } from '@application/use-cases/ListIpNetworks';
import { CreateIpNetwork } from '@application/use-cases/CreateIpNetwork';
import { DeleteIpNetwork } from '@application/use-cases/DeleteIpNetwork';
import { ListIpPools } from '@application/use-cases/ListIpPools';
import { CreateIpPool } from '@application/use-cases/CreateIpPool';
import { ListPppoeAssignments } from '@application/use-cases/ListPppoeAssignments';
import { DeleteIpPool } from '@application/use-cases/DeleteIpPool';
import { ListIpv6Networks } from '@application/use-cases/ListIpv6Networks';
import { CreateIpv6Network } from '@application/use-cases/CreateIpv6Network';

type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/**
 * Redes / pools / asignaciones de IP. Estaban montadas en /api SIN auth ni permiso (agujero;
 * fix `network-routes-guard`) — incluyendo data sensible (GET /ip-pools, GET /ip-assignments).
 * `network.read` para listar; `network.manage` para las mutaciones.
 *
 * Bug 3: GET /ip-assignments ahora llama `ListPppoeAssignments` (datos reales de PppoeService)
 * en lugar del legacy `ListIpAssignments` (datos del modelo IP estático). El endpoint, path y
 * guards se mantienen intactos — solo cambia la fuente de datos.
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
  listPppoeAssignments: ListPppoeAssignments,
  deleteIpPool?: DeleteIpPool,
  listIpv6Networks?: ListIpv6Networks,
  createIpv6Network?: CreateIpv6Network,
): Router {
  const router = Router();
  const auth      = createAuthMiddleware(authProvider, sessionRepo);
  const canRead   = requirePerm('network', 'read');
  const canManage = requirePerm('network', 'manage');

  // IP Networks
  router.get('/ip-networks', auth, canRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const networks = await listIpNetworks.execute();
      res.json(networks);
    } catch (err) {
      next(err);
    }
  });

  router.post('/ip-networks', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const network = await createIpNetwork.execute(req.body);
      res.status(201).json(network);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/ip-networks/:id', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const deleted = await deleteIpNetwork.execute(req.params['id'] as string);
      if (!deleted) {
        res.status(404).json({ error: 'IP network not found', code: 'IP_NETWORK_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // IP Pools
  router.get('/ip-pools', auth, canRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const pools = await listIpPools.execute();
      res.json(pools);
    } catch (err) {
      next(err);
    }
  });

  router.post('/ip-pools', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const pool = await createIpPool.execute(req.body);
      res.status(201).json(pool);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/ip-pools/:id', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!deleteIpPool) { res.status(501).json({ error: 'Not implemented' }); return; }
      const deleted = await deleteIpPool.execute(req.params['id'] as string);
      if (!deleted) {
        res.status(404).json({ error: 'IP pool not found', code: 'IP_POOL_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // IP Assignments — fuente = PppoeService (asignados: contractId+IP+enabled). Paginado.
  router.get('/ip-assignments', auth, canRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawPage     = parseInt(String(req.query['page']     ?? '1'),  10);
      const rawPageSize = parseInt(String(req.query['pageSize'] ?? '25'), 10);
      const search      = req.query['search'] ? String(req.query['search'])  : undefined;
      const nasId       = req.query['nasId']  ? String(req.query['nasId'])   : undefined;

      const page     = Math.max(1,   isNaN(rawPage)     ? 1  : rawPage);
      const pageSize = Math.min(200, Math.max(1, isNaN(rawPageSize) ? 25 : rawPageSize));

      const result = await listPppoeAssignments.execute({ page, pageSize, search, nasId });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // IPv6 Networks
  router.get('/ipv6-networks', auth, canRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!listIpv6Networks) { res.json([]); return; }
      const networks = await listIpv6Networks.execute();
      res.json(networks);
    } catch (err) {
      next(err);
    }
  });

  router.post('/ipv6-networks', auth, canManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!createIpv6Network) { res.status(501).json({ error: 'Not implemented' }); return; }
      const network = await createIpv6Network.execute(req.body);
      res.status(201).json(network);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
