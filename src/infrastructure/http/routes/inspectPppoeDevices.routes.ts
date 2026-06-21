/**
 * inspectPppoeDevices.routes.ts — ruta de inspección SSH de antena airOS.
 *
 * Endpoint:
 *   GET /api/contracts/:contractId/inspect-pppoe-devices   inventory.write
 *
 * Nota de diseño:
 * - Se usa `inventory.write` (no `pppoe.read`) porque el objetivo es detectar equipos
 *   para registrar en el inventario del contrato — acción de inventario, no de PPPoE.
 * - Siempre retorna 200 (best-effort): los errores de red de la antena van en `warnings`,
 *   nunca en el status HTTP. La inspección no debe bloquear el flujo del operador.
 */
import { Router, Request, Response, RequestHandler, NextFunction } from 'express';
import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { InspectPppoeDevices } from '@application/use-cases/InspectPppoeDevices';

type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

export function createInspectPppoeDevicesRouter(
  inspectPppoeDevices: InspectPppoeDevices,
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
): Router {
  const router = Router();
  const auth       = createAuthMiddleware(authProvider, sessionRepo);
  const canWrite   = requirePerm('inventory', 'write');

  /**
   * GET /contracts/:contractId/inspect-pppoe-devices
   *
   * Inspecciona la antena airOS del PPPoE activo del contrato por SSH.
   * Retorna `{ antenna, router, warnings }`.
   * Siempre 200 — errores de conectividad van en `warnings` (best-effort).
   */
  router.get(
    '/contracts/:contractId/inspect-pppoe-devices',
    auth,
    canWrite,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const result = await inspectPppoeDevices.execute(req.params['contractId'] as string);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
