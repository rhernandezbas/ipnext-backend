import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import type { SessionRepository } from '@domain/ports/SessionRepository';

import { GetAdminOnuWifiStatus } from '@application/use-cases/wifi/GetAdminOnuWifiStatus';
import { SetAdminWifiBand } from '@application/use-cases/wifi/SetAdminWifiBand';
import { EnableOnuTr069 } from '@application/use-cases/wifi/EnableOnuTr069';
import { SetAdminWifiBandSchema, EnableOnuTr069Schema, VLAN_HINT } from '@application/dto/wifi.dto';
import { WifiValidationError } from '@domain/errors/wifi';

type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/**
 * wifi-self-service (F0) — `/api/wifi` (admin/staff). Rutas por SERIAL (no por
 * contrato — staff opera ONUs aunque no estén asociadas todavía, proposal.md
 * F0). Permisos NUEVOS `wifi.read`/`wifi.manage` (seed idempotente calcado de
 * `promos`, ver migración `..._wifi_self_service_permissions`).
 *
 * SmartOLT sin configurar: los use cases usan `WifiManagementPort`/
 * `OltProvisioningGateway`, que tiran `OltProvisioningError('not_configured', ...)`
 * ANTES de tocar la red — el `next(err)` de acá abajo lo deja llegar al
 * errorHandler global, que YA mapea `SMARTOLT_NOT_CONFIGURED -> 503` (molde
 * `fiber.routes.ts` / smartolt-provision K2) — nada explota, ninguna
 * middleware de "ready" extra hace falta.
 */
export function createWifiRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
  getAdminOnuWifiStatus: GetAdminOnuWifiStatus,
  setAdminWifiBand: SetAdminWifiBand,
  enableOnuTr069: EnableOnuTr069,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider, sessionRepo);
  const canRead = requirePerm('wifi', 'read');
  const canManage = requirePerm('wifi', 'manage');

  router.get(
    '/onu/:serial',
    auth,
    canRead,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const data = await getAdminOnuWifiStatus.execute(req.params['serial'] as string);
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  router.put(
    '/onu/:serial/band',
    auth,
    canManage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const parsed = SetAdminWifiBandSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        // wifi-password-snapshot — `staffUserId` SOLO de la sesión ya
        // autenticada (`req.user`, poblado por `auth` arriba), NUNCA del body.
        await setAdminWifiBand.execute(req.params['serial'] as string, parsed.data, req.user!.id);
        res.status(200).json({ applied: true });
      } catch (err) {
        if (err instanceof WifiValidationError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        next(err);
      }
    },
  );

  router.post(
    '/onu/:serial/enable-tr069',
    auth,
    canManage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      // vlan SIN default (proposal: "el operador la elige") — 400 con la
      // pista de vlans conocidas cuando falta, ANTES de zod (mensaje propio).
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body['vlan'] === undefined || body['vlan'] === null) {
        res.status(400).json({ error: VLAN_HINT, code: 'VALIDATION_ERROR' });
        return;
      }
      const parsed = EnableOnuTr069Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        await enableOnuTr069.execute(req.params['serial'] as string, parsed.data);
        res.status(200).json({ applied: true });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
