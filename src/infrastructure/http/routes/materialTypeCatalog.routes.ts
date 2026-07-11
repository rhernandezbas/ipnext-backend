import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListMaterial } from '@application/use-cases/ListMaterial';
import { GetMaterial } from '@application/use-cases/GetMaterial';
import { CreateMaterial } from '@application/use-cases/CreateMaterial';
import { UpdateMaterial } from '@application/use-cases/UpdateMaterial';
import { DeleteMaterial } from '@application/use-cases/DeleteMaterial';
import { MaterialCatalogService } from '@application/services/MaterialCatalogService';
import { CreateMaterialSchema, UpdateMaterialSchema } from '@application/dto/inventory.dto';
import {
  MaterialNotFoundError,
  MaterialNameConflictError,
  MaterialInUseError,
  MaterialProtectedError,
  InvalidMinStockError,
} from '@domain/errors/inventory';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

export function createMaterialTypeCatalogRouter(
  authProvider: AuthProvider,
  requirePerm: RequirePerm,
  list: ListMaterial,
  get: GetMaterial,
  create: CreateMaterial,
  update: UpdateMaterial,
  del: DeleteMaterial,
  service: MaterialCatalogService,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);
  const readPerm   = requirePerm('inventory', 'read');
  const managePerm = requirePerm('inventory', 'manage');

  router.get('/material-types', auth, readPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await list.execute());
    } catch (err) {
      next(err);
    }
  });

  router.get('/material-types/:id', auth, readPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await get.execute(req.params['id'] as string));
    } catch (err) {
      if (err instanceof MaterialNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.post('/material-types', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateMaterialSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const result = await create.execute(parsed.data);
      service.invalidate();
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof MaterialNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.put('/material-types/:id', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateMaterialSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const result = await update.execute(req.params['id'] as string, parsed.data);
      service.invalidate();
      res.json(result);
    } catch (err) {
      if (err instanceof MaterialNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof MaterialNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // FIX-5a: InvalidMinStockError from the use case must map to 400, not 500.
      if (err instanceof InvalidMinStockError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.delete('/material-types/:id', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await del.execute(req.params['id'] as string);
      service.invalidate();
      res.status(204).send();
    } catch (err) {
      if (err instanceof MaterialNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof MaterialInUseError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof MaterialProtectedError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  return router;
}
