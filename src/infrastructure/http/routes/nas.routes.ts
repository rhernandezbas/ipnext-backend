import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
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
import { FindFreeIp } from '@application/use-cases/FindFreeIp';
import { SetNasPoolMode } from '@application/use-cases/SetNasPoolMode';
import type { IpKind } from '@domain/entities/network';
import { NasNotFoundError, RadiusPoolEmptyError, OrchestratorUnreachableError } from '@domain/errors/pppoe';
import { z } from 'zod';

type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/** pppoe-pool-ip: body de POST /nas-servers/:id/pool-mode. `poolName` no nulo = marcar pool-mode; null = desactivar. */
const PoolModeBodySchema = z.object({ poolName: z.string().min(1).nullable() });

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
  findFreeIp?: FindFreeIp,
  setNasPoolMode?: SetNasPoolMode,
): Router {
  const router = Router();
  const auth      = createAuthMiddleware(authProvider, sessionRepo);
  const canRead   = requirePerm('network', 'read');
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

  // pppoe-pool-ip (Decisión 3): marca/desmarca el NAS en modo pool. `network.manage`.
  // Pre-check: poolName no nulo exige que el pool exista y tenga IPs libres en el RADIUS.
  // Errores: NAS inexistente → 404; pool vacío/inexistente → 409; orchestrator caído → 502.
  if (setNasPoolMode) {
    router.post('/nas-servers/:id/pool-mode', auth, canManage, async (req: Request, res: Response): Promise<void> => {
      const parsed = PoolModeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const nas = await setNasPoolMode.execute({ nasId: req.params['id'] as string, poolName: parsed.data.poolName });
        // Frontera de seguridad: NUNCA devolver radiusSecret/apiPassword crudos. El use case
        // retorna la entidad cruda del repo (el Prisma repo trae el secreto real); enmascarar
        // acá con la convención del codebase ('••••••••'). (Deuda pre-existente: ListNasServers/
        // GetNasServer NO enmascaran en prod — el in-memory seedea enmascarado y oculta el leak.)
        res.json({ ...nas, radiusSecret: '••••••••', apiPassword: nas.apiPassword == null ? null : '••••••••' });
      } catch (err) {
        if (err instanceof NasNotFoundError) {
          res.status(404).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof RadiusPoolEmptyError) {
          res.status(409).json({ code: err.code, error: err.message });
          return;
        }
        if (err instanceof OrchestratorUnreachableError) {
          res.status(502).json({ code: err.code, error: err.message });
          return;
        }
        throw err;
      }
    });
  }

  // Radius Config
  router.get('/radius-config', auth, async (_req: Request, res: Response): Promise<void> => {
    const config = await getRadiusConfig.execute();
    res.json(config);
  });

  router.put('/radius-config', auth, canManage, async (req: Request, res: Response): Promise<void> => {
    const config = await updateRadiusConfig.execute(req.body);
    res.json(config);
  });

  // IP allocator (ip-allocator / FindFreeIp): primer IP libre de un NAS para `cgnat|public`.
  // `network.read` — misma lectura que GET /ip-pools. Errores de dominio (NAS/pool inexistente,
  // pool agotado) los mapea el errorHandler vía DomainError.code.
  router.get('/nas/:nasId/next-free-ip', auth, canRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!findFreeIp) { res.status(501).json({ error: 'Not implemented', code: 'NOT_IMPLEMENTED' }); return; }
    const type = req.query['type'];
    if (type !== 'cgnat' && type !== 'public') {
      res.status(400).json({ error: "query 'type' debe ser 'cgnat' o 'public'", code: 'INVALID_IP_TYPE' });
      return;
    }
    try {
      const ip = await findFreeIp.execute({ nasId: req.params['nasId'] as string, type: type as IpKind });
      res.json({ ip });
    } catch (err) {
      // Errores de dominio (NAS/pool inexistente, pool agotado) → errorHandler global vía code.
      next(err);
    }
  });

  return router;
}
