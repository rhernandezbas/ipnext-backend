import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListDeviceType } from '@application/use-cases/ListDeviceType';
import { GetDeviceType } from '@application/use-cases/GetDeviceType';
import { CreateDeviceType } from '@application/use-cases/CreateDeviceType';
import { UpdateDeviceType } from '@application/use-cases/UpdateDeviceType';
import { DeleteDeviceType } from '@application/use-cases/DeleteDeviceType';
import { DeviceTypeCatalogService } from '@application/services/DeviceTypeCatalogService';
import { CreateDeviceTypeSchema, UpdateDeviceTypeSchema } from '@application/dto/inventory.dto';
import {
  DeviceTypeNotFoundError,
  DeviceTypeNameConflictError,
  DeviceTypeInUseError,
  DeviceTypeProtectedError,
  DeviceTypeNonRenameableError,
} from '@domain/errors/inventory';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

export function createDeviceTypeCatalogRouter(
  authProvider: AuthProvider,
  requirePerm: RequirePerm,
  list: ListDeviceType,
  get: GetDeviceType,
  create: CreateDeviceType,
  update: UpdateDeviceType,
  del: DeleteDeviceType,
  service: DeviceTypeCatalogService,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);
  const readPerm   = requirePerm('inventory', 'read');
  const managePerm = requirePerm('inventory', 'manage');

  router.get('/device-types', auth, readPerm, async (_req: Request, res: Response): Promise<void> => {
    res.json(await list.execute());
  });

  router.get('/device-types/:id', auth, readPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await get.execute(req.params['id'] as string));
    } catch (err) {
      if (err instanceof DeviceTypeNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.post('/device-types', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateDeviceTypeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const result = await create.execute(parsed.data);
      service.invalidate();
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof DeviceTypeNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.put('/device-types/:id', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateDeviceTypeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const result = await update.execute(req.params['id'] as string, parsed.data);
      service.invalidate();
      res.json(result);
    } catch (err) {
      if (err instanceof DeviceTypeNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof DeviceTypeNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof DeviceTypeNonRenameableError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.delete('/device-types/:id', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await del.execute(req.params['id'] as string);
      service.invalidate();
      res.status(204).send();
    } catch (err) {
      if (err instanceof DeviceTypeNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof DeviceTypeInUseError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof DeviceTypeProtectedError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  return router;
}
