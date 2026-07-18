import { Request, Response, NextFunction, RequestHandler } from 'express';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';

/**
 * messaging-inbox-notes (edit/delete) — middleware NO-bloqueante que resuelve si el
 * usuario autenticado es SUPERVISOR de mensajería (`messaging:manage`) y lo deja en
 * `req.messagingCanManage`. Mismo camino de resolución que `requirePermission` (super_admin
 * short-circuit → listPermissionsForUser), pero jamás corta el request: la autorización
 * FINA (autor O supervisor) vive DENTRO del use case (EditInternalNote/DeleteInternalNote),
 * no en el gate — la ruta ya está gateada por `messaging:send`. Fail-CLOSED: cualquier
 * error de lookup deja `false` (sólo el autor podrá mutar su nota).
 *
 * `req.messagingCanManage` se declara en `src/types/express.d.ts`.
 */
export function attachMessagingManage(userRepo: RbacUserRepository): RequestHandler {
  return async function attach(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const userId = req.user?.id;
    if (!userId) {
      req.messagingCanManage = false;
      next();
      return;
    }
    try {
      const roles = await userRepo.listRolesForUser(userId);
      if (roles.some((r) => r.code === 'super_admin')) {
        req.messagingCanManage = true;
        next();
        return;
      }
      const perms = await userRepo.listPermissionsForUser(userId);
      req.messagingCanManage = perms.some((p) => p.moduleCode === 'messaging' && p.action === 'manage');
    } catch {
      // Fail-closed — un lookup roto NUNCA concede permisos de supervisor.
      req.messagingCanManage = false;
    }
    next();
  };
}
