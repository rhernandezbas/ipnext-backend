import { Router, Request, Response, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListServiceCatalog } from '@application/use-cases/ListServiceCatalog';
import { CreateServiceCatalog } from '@application/use-cases/CreateServiceCatalog';
import { UpdateServiceCatalog } from '@application/use-cases/UpdateServiceCatalog';
import { DeleteServiceCatalog } from '@application/use-cases/DeleteServiceCatalog';
import { CreateServiceCatalogSchema, UpdateServiceCatalogSchema } from '@application/dto/contract-services.dto';
import {
  ServiceCatalogNotFoundError,
  ServiceCatalogNameConflictError,
  ServiceCatalogInUseError,
  ServiceCatalogProtectedError,
  ServiceCatalogNonRenameableError,
} from '@domain/errors/contractServices';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

export function createServiceCatalogRouter(
  authProvider: AuthProvider,
  requirePerm: RequirePerm,
  list: ListServiceCatalog,
  create: CreateServiceCatalog,
  update: UpdateServiceCatalog,
  del: DeleteServiceCatalog,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);
  const readPerm   = requirePerm('clients', 'read');
  const managePerm = requirePerm('clients', 'manage');

  router.get('/service-catalog', auth, readPerm, async (req: Request, res: Response): Promise<void> => {
    const filter = req.query['active'] === 'true' ? { active: true } : undefined;
    res.json(await list.execute(filter));
  });

  router.post('/service-catalog', auth, managePerm, async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateServiceCatalogSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.status(201).json(await create.execute(parsed.data));
    } catch (err) {
      if (err instanceof ServiceCatalogNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  router.patch('/service-catalog/:id', auth, managePerm, async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateServiceCatalogSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await update.execute(req.params['id'] as string, parsed.data));
    } catch (err) {
      if (err instanceof ServiceCatalogNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ServiceCatalogNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ServiceCatalogNonRenameableError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  router.delete('/service-catalog/:id', auth, managePerm, async (req: Request, res: Response): Promise<void> => {
    try {
      await del.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof ServiceCatalogNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ServiceCatalogInUseError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ServiceCatalogProtectedError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  return router;
}
