import { Router, Request, Response, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListNasServers } from '@application/use-cases/ListNasServers';
import { GetNasServer } from '@application/use-cases/GetNasServer';
import { CreateNasServer } from '@application/use-cases/CreateNasServer';
import { UpdateNasServer } from '@application/use-cases/UpdateNasServer';
import { DeleteNasServer } from '@application/use-cases/DeleteNasServer';
import { GetRadiusConfig } from '@application/use-cases/GetRadiusConfig';
import { UpdateRadiusConfig } from '@application/use-cases/UpdateRadiusConfig';

type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/**
 * NAS / RADIUS-config routes.
 *
 * SEGURIDAD: estas rutas estaban montadas en `/api` SIN auth ni permiso (agujero).
 * Ahora: `auth` en TODAS; `network.manage` en las mutaciones (POST/PUT/DELETE + PUT radius-config).
 * Los GET quedan auth-only a proposito: `GET /nas-servers` lo consume el dropdown de routers
 * del InternetPanel (usuarios con `pppoe.manage`, que no necesariamente tienen `network.read`).
 */
export function createNasRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
  listNasServers: ListNasServers,
  getNasServer: GetNasServer,
  createNasServer: CreateNasServer,
  updateNasServer: UpdateNasServer,
  deleteNasServer: DeleteNasServer,
  getRadiusConfig: GetRadiusConfig,
  updateRadiusConfig: UpdateRadiusConfig,
): Router {
  const router = Router();
  const auth      = createAuthMiddleware(authProvider, sessionRepo);
  const canManage = requirePerm('network', 'manage');

  // NAS Servers
  router.get('/nas-servers', auth, async (_req: Request, res: Response): Promise<void> => {
    const servers = await listNasServers.execute();
    res.json(servers);
  });

  router.post('/nas-servers', auth, canManage, async (req: Request, res: Response): Promise<void> => {
    const server = await createNasServer.execute(req.body);
    res.status(201).json(server);
  });

  router.get('/nas-servers/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const server = await getNasServer.execute(req.params['id'] as string);
    if (!server) {
      res.status(404).json({ error: 'NAS server not found', code: 'NAS_SERVER_NOT_FOUND' });
      return;
    }
    res.json(server);
  });

  router.put('/nas-servers/:id', auth, canManage, async (req: Request, res: Response): Promise<void> => {
    const server = await updateNasServer.execute(req.params['id'] as string, req.body);
    if (!server) {
      res.status(404).json({ error: 'NAS server not found', code: 'NAS_SERVER_NOT_FOUND' });
      return;
    }
    res.json(server);
  });

  router.delete('/nas-servers/:id', auth, canManage, async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteNasServer.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'NAS server not found', code: 'NAS_SERVER_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  // Radius Config
  router.get('/radius-config', auth, async (_req: Request, res: Response): Promise<void> => {
    const config = await getRadiusConfig.execute();
    res.json(config);
  });

  router.put('/radius-config', auth, canManage, async (req: Request, res: Response): Promise<void> => {
    const config = await updateRadiusConfig.execute(req.body);
    res.json(config);
  });

  return router;
}
