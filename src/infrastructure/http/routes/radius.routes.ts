import { Router, Request, Response, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListRadiusSessions } from '@application/use-cases/ListRadiusSessions';
import { DisconnectSession } from '@application/use-cases/DisconnectSession';

type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/**
 * Sesiones RADIUS. Estaban montadas en /api/radius SIN auth ni permiso (agujero; fix `network-routes-guard`).
 * `network.read` para listar; `network.manage` para desconectar (acción destructiva).
 */
export function createRadiusRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
  listRadiusSessions: ListRadiusSessions,
  disconnectSession: DisconnectSession,
): Router {
  const router = Router();
  const auth      = createAuthMiddleware(authProvider, sessionRepo);
  const canRead   = requirePerm('network', 'read');
  const canManage = requirePerm('network', 'manage');

  router.get('/sessions', auth, canRead, async (_req: Request, res: Response): Promise<void> => {
    const sessions = await listRadiusSessions.execute();
    res.json(sessions);
  });

  router.delete('/sessions/:id', auth, canManage, async (req: Request, res: Response): Promise<void> => {
    const result = await disconnectSession.execute(req.params['id'] as string);
    res.json(result);
  });

  return router;
}
