import { Router, Request, Response, RequestHandler, NextFunction } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ProvisionFiberOnu } from '@application/use-cases/ProvisionFiberOnu';
import { ListUnconfiguredOnus } from '@application/use-cases/ListUnconfiguredOnus';
import { ListSmartOltOlts } from '@application/use-cases/ListSmartOltOlts';
import { UpdateSmartOltOlt } from '@application/use-cases/UpdateSmartOltOlt';
import {
  ProvisionFiberOnuSchema,
  UpdateSmartOltOltSchema,
  UpdateSmartOltOltBody,
} from '@application/dto/fiberProvision.dto';

type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/** Flag runtime del feature (seed OFF por migración — rollout oscuro, botón-driven). */
export const FIBER_PROVISION_FLAG = 'fiber-auto-provision';

/**
 * Readiness del aprovisionamiento de fibra (patrón gigared ready middleware):
 *  - Envs SMARTOLT_* ausentes → 503 SMARTOLT_NOT_CONFIGURED (feature apagada
 *    limpia — el resto de la app ni se entera).
 *  - Flag 'fiber-auto-provision' OFF (o ausente: fail-closed) → 409
 *    FIBER_PROVISION_DISABLED. Chequeado POR REQUEST: se prende via
 *    /feature-flags sin redeploy.
 *
 * La config del catálogo de OLTs (GET/PUT /olts) NO pasa por acá — igual que
 * gigared /config: el operador configura ANTES de prender el flag.
 */
export function createFiberReadyMiddleware(
  flagRepo: FeatureFlagRepository,
  smartoltConfigured: boolean,
): RequestHandler {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!smartoltConfigured) {
        res.status(503).json({
          error: 'SmartOLT no está configurado (SMARTOLT_BASE_URL / SMARTOLT_API_TOKEN)',
          code: 'SMARTOLT_NOT_CONFIGURED',
        });
        return;
      }
      const flag = await flagRepo.get(FIBER_PROVISION_FLAG);
      if (!flag?.enabled) {
        res.status(409).json({
          error: `El aprovisionamiento automático de fibra está apagado (flag '${FIBER_PROVISION_FLAG}')`,
          code: 'FIBER_PROVISION_DISABLED',
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * smartolt-provision (K2) — rutas del aprovisionamiento de ONUs fibra Huawei.
 * Montado en /api/fiber. SIN cron: TODO es botón-driven desde el FE.
 *
 *  GET  /unconfigured-onus  — picker del FE (network.read + ready)
 *  POST /provision          — aprovisionar/dry-run (network.manage + ready + Zod)
 *  GET  /olts               — catálogo de OLTs (network.read; accesible con flag OFF)
 *  PUT  /olts/:id           — editar catálogo (admin.manage; accesible con flag OFF)
 *
 * Errores de dominio → next(err) → errorHandler global (statusMap única fuente
 * de verdad: ONU_NOT_HUAWEI/FIBER_VLAN_REQUIRED/SMARTOLT_* etc.).
 */
export function createFiberRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
  flagRepo: FeatureFlagRepository,
  smartoltConfigured: boolean,
  listUnconfiguredOnus: ListUnconfiguredOnus,
  provisionFiberOnu: ProvisionFiberOnu,
  listSmartOltOlts: ListSmartOltOlts,
  updateSmartOltOlt: UpdateSmartOltOlt,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider, sessionRepo);
  const canRead = requirePerm('network', 'read');
  const canManage = requirePerm('network', 'manage');
  // Catálogo de OLTs: superficie de configuración → gate admin (decisión K2).
  const canAdmin = requirePerm('admin', 'manage');
  const fiberReady = createFiberReadyMiddleware(flagRepo, smartoltConfigured);

  // ── Picker del FE: ONUs detectadas sin configurar ───────────────────────────
  router.get(
    '/unconfigured-onus',
    auth,
    canRead,
    fiberReady,
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const data = await listUnconfiguredOnus.execute();
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Aprovisionar (o dry-run) una ONU ────────────────────────────────────────
  router.post(
    '/provision',
    auth,
    canManage,
    fiberReady,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const parsed = ProvisionFiberOnuSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: 'Invalid provision payload',
            code: 'VALIDATION_ERROR',
            details: parsed.error.issues,
          });
          return;
        }
        const result = await provisionFiberOnu.execute(parsed.data);
        res.json({ data: result });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Catálogo de OLTs (config — accesible con flag OFF) ──────────────────────
  router.get(
    '/olts',
    auth,
    canRead,
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const data = await listSmartOltOlts.execute();
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  router.put(
    '/olts/:id',
    auth,
    canAdmin,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const parsed = UpdateSmartOltOltSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: 'Invalid OLT config payload',
            code: 'VALIDATION_ERROR',
            details: parsed.error.issues,
          });
          return;
        }
        // Semántica "omitido ≠ null": solo forwardear las keys PRESENTES en el body.
        const patch: UpdateSmartOltOltBody = {};
        if ('name' in req.body) patch.name = parsed.data.name;
        if ('serviceVlanDefault' in req.body) patch.serviceVlanDefault = parsed.data.serviceVlanDefault ?? null;
        if ('mgmtVlan' in req.body) patch.mgmtVlan = parsed.data.mgmtVlan ?? null;
        const data = await updateSmartOltOlt.execute(req.params['id'] as string, patch);
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
