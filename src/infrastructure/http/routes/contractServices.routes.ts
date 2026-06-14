import { Router, Request, Response, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { UpdateContractName } from '@application/use-cases/UpdateContractName';
import { AddContractService } from '@application/use-cases/AddContractService';
import { UpdateContractService } from '@application/use-cases/UpdateContractService';
import { RemoveContractService } from '@application/use-cases/RemoveContractService';
import { ListContractServiceHistory } from '@application/use-cases/ListContractServiceHistory';
import {
  UpdateContractNameSchema,
  AddContractServiceSchema,
  UpdateContractServiceSchema,
  toContractServiceDto,
} from '@application/dto/contract-services.dto';
import {
  ContractNotFoundError,
  ServiceCatalogNotFoundError,
  ServiceCatalogInactiveError,
  ContractServiceDuplicateError,
  ContractServiceNotFoundError,
} from '@domain/errors/contractServices';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/** Extract actor from req.user (set by authMiddleware). Matches pattern in scheduling.routes.ts */
function actorOf(req: Request): { actorId: string | null; actorName: string } {
  return {
    actorId:   req.user?.id ?? null,
    actorName: req.user?.username ?? '',
  };
}

export function createContractServicesRouter(
  authProvider: AuthProvider,
  requirePerm: RequirePerm,
  updateContractName: UpdateContractName,
  addSvc: AddContractService,
  updateSvc: UpdateContractService,
  removeSvc: RemoveContractService,
  listHistory: ListContractServiceHistory,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);
  const writePerm = requirePerm('clients', 'write');
  const readPerm  = requirePerm('clients', 'read');

  // ── PATCH /contracts/:id — set/clear the manual name ─────────────────────────
  router.patch('/contracts/:id', auth, writePerm, async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateContractNameSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await updateContractName.execute(req.params['id'] as string, parsed.data.name));
    } catch (err) {
      if (err instanceof ContractNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  // ── POST /contracts/:contractId/services — add a service ─────────────────────
  router.post('/contracts/:contractId/services', auth, writePerm, async (req: Request, res: Response): Promise<void> => {
    const parsed = AddContractServiceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      // #110 — thread actor from req.user for event registration
      const result = await addSvc.execute(
        req.params['contractId'] as string,
        parsed.data,
        actorOf(req),
      );
      // H3 — never leak the TV credentials on a contract-service response.
      res.status(201).json(toContractServiceDto(result));
    } catch (err) {
      if (err instanceof ContractNotFoundError || err instanceof ServiceCatalogNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ServiceCatalogInactiveError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ContractServiceDuplicateError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  // ── PATCH /contracts/:contractId/services/:id — update status/notes ──────────
  router.patch('/contracts/:contractId/services/:id', auth, writePerm, async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateContractServiceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      // #110 — thread actor from req.user for event registration
      const updated = await updateSvc.execute(
        req.params['id'] as string,
        parsed.data,
        actorOf(req),
      );
      // H3 — never leak the TV credentials on a contract-service response.
      res.json(toContractServiceDto(updated));
    } catch (err) {
      if (err instanceof ContractServiceNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  // ── DELETE /contracts/:contractId/services/:id — idempotent remove ───────────
  router.delete('/contracts/:contractId/services/:id', auth, writePerm, async (req: Request, res: Response): Promise<void> => {
    // #110 — thread actor from req.user for event registration
    await removeSvc.execute(req.params['id'] as string, actorOf(req));
    res.status(204).send();
  });

  // ── GET /contracts/:contractId/service-history — full history (#73, #110) ─────
  router.get('/contracts/:contractId/service-history', auth, readPerm, async (req: Request, res: Response): Promise<void> => {
    const dtos = await listHistory.execute(req.params['contractId'] as string);
    res.json(dtos);
  });

  return router;
}
