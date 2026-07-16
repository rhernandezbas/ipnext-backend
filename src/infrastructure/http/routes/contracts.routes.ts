import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListContracts } from '@application/use-cases/ListContracts';
import { GetContractStats } from '@application/use-cases/GetContractStats';
import { UpdateContractLocation } from '@application/use-cases/UpdateContractLocation';
import { SetContractNetworkAssignment } from '@application/use-cases/SetContractNetworkAssignment';
import { InvalidLocationError } from '@domain/errors/geolocation';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import {
  NetworkSiteNotFoundError,
  AccessPointNotFoundError,
  AccessPointRetiredError,
  AccessPointNotInSiteError,
} from '@domain/errors/networkAssignment';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/** Zod schema for PATCH /contracts/:id/location — whitelist ONLY Prominense-owned GPS fields. */
const UpdateContractLocationSchema = z.object({
  gpsLat: z.number().min(-90).max(90).nullable().optional(),
  gpsLng: z.number().min(-180).max(180).nullable().optional(),
  gpsPlusCode: z.string().nullable().optional(),
});

/**
 * contract-node-ap-auto-assign (PICK-3) — Zod schema for PATCH /contracts/:id/network-assignment.
 * `.strict()` rejects unknown keys (400). At least ONE of the two keys MUST be present (400) —
 * `undefined` = "don't touch", so an empty body would otherwise be a silent no-op.
 */
const SetContractNetworkAssignmentSchema = z
  .object({
    networkSiteId: z.string().nullable().optional(),
    accessPointId: z.string().nullable().optional(),
  })
  .strict()
  .refine(
    (data) => data.networkSiteId !== undefined || data.accessPointId !== undefined,
    { message: 'At least one of networkSiteId or accessPointId must be provided' },
  );

/**
 * GET /api/contracts       — global paginated contracts listing for the contracts page.
 * GET /api/contracts/stats — total + byStatus breakdown (dynamic, no hardcoded statuses).
 * PATCH /api/contracts/:id/location — update Prominense-owned GPS (gpsLat/gpsLng/gpsPlusCode).
 *
 * IMPORTANT: /stats MUST be declared before /contracts so it is matched first
 * (Express matches in declaration order and /contracts has no /:id catch-all today,
 * but /stats is kept first as a defensive convention).
 */
export function createContractsRouter(
  authProvider: AuthProvider,
  listContracts: ListContracts,
  getContractStats: GetContractStats,
  updateContractLocation?: UpdateContractLocation,
  requirePerm?: RequirePerm,
  setContractNetworkAssignment?: SetContractNetworkAssignment,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);
  const writePerm: RequestHandler = requirePerm ? requirePerm('clients', 'write') : (_req, _res, next) => next();
  // PICK-3: gate granular reusando la action existente 'assign' (design §14.4) — cero cambios TS.
  const assignPerm: RequestHandler = requirePerm ? requirePerm('contracts', 'assign') : (_req, _res, next) => next();

  // IMPORTANT: /stats MUST be declared before any /:id catch-all (defensive ordering).
  router.get('/contracts/stats', auth, async (_req: Request, res: Response): Promise<void> => {
    try {
      const stats = await getContractStats.execute();
      res.json(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load contract stats';
      res.status(500).json({ error: message, code: 'INTERNAL_ERROR' });
    }
  });

  router.get('/contracts', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { page, limit, search, status, technology } = req.query as Record<string, string>;
      const result = await listContracts.execute({
        page: page ? +page : 1,
        limit: limit ? +limit : 25,
        search,
        status,
        technology,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * PATCH /contracts/:id/location — update Prominense-owned GPS location on a contract.
   * Whitelisted body: gpsLat, gpsLng, gpsPlusCode. GR lat/lng are NEVER touched.
   * Gate: clients.write.
   */
  router.patch('/contracts/:id/location', auth, writePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!updateContractLocation) {
      res.status(501).json({ error: 'Not implemented', code: 'NOT_IMPLEMENTED' });
      return;
    }
    const parsed = UpdateContractLocationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const result = await updateContractLocation.execute({
        id: req.params['id'] as string,
        gpsLat: parsed.data.gpsLat,
        gpsLng: parsed.data.gpsLng,
        gpsPlusCode: parsed.data.gpsPlusCode,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof ContractNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof InvalidLocationError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  /**
   * PATCH /contracts/:id/network-assignment — picker manual del nodo/AP (PICK-3, design §9.1/§9.3).
   * Whitelisted body (zod .strict()): networkSiteId?, accessPointId? — al menos una key.
   * Gate: contracts.assign.
   */
  router.patch('/contracts/:id/network-assignment', auth, assignPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!setContractNetworkAssignment) {
      res.status(501).json({ error: 'Not implemented', code: 'NOT_IMPLEMENTED' });
      return;
    }
    const parsed = SetContractNetworkAssignmentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const result = await setContractNetworkAssignment.execute({
        contractId: req.params['id'] as string,
        networkSiteId: parsed.data.networkSiteId,
        accessPointId: parsed.data.accessPointId,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof ContractNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (
        err instanceof NetworkSiteNotFoundError ||
        err instanceof AccessPointNotFoundError ||
        err instanceof AccessPointRetiredError ||
        err instanceof AccessPointNotInSiteError
      ) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  return router;
}
