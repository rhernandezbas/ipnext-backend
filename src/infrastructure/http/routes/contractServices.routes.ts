import { Router, Request, Response, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { UpdateContractName } from '@application/use-cases/UpdateContractName';
import { AddContractService } from '@application/use-cases/AddContractService';
import { UpdateContractService } from '@application/use-cases/UpdateContractService';
import { RemoveContractService } from '@application/use-cases/RemoveContractService';
import {
  UpdateContractNameSchema,
  AddContractServiceSchema,
  UpdateContractServiceSchema,
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

export function createContractServicesRouter(
  authProvider: AuthProvider,
  requirePerm: RequirePerm,
  updateContractName: UpdateContractName,
  addSvc: AddContractService,
  updateSvc: UpdateContractService,
  removeSvc: RemoveContractService,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);
  const writePerm = requirePerm('clients', 'write');

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
      const result = await addSvc.execute(req.params['contractId'] as string, parsed.data);
      res.status(201).json(result);
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
      res.json(await updateSvc.execute(req.params['id'] as string, parsed.data));
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
    await removeSvc.execute(req.params['id'] as string);
    res.status(204).send();
  });

  return router;
}
