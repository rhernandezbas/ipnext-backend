import { Router, Request, Response } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListServiceTechnology } from '@application/use-cases/ListServiceTechnology';
import { GetServiceTechnology } from '@application/use-cases/GetServiceTechnology';
import { CreateServiceTechnology } from '@application/use-cases/CreateServiceTechnology';
import { UpdateServiceTechnology } from '@application/use-cases/UpdateServiceTechnology';
import { DeleteServiceTechnology } from '@application/use-cases/DeleteServiceTechnology';
import { CreateServiceTechnologySchema, UpdateServiceTechnologySchema } from '@application/dto/serviceTechnology.dto';
import {
  ServiceTechnologyNotFoundError,
  ServiceTechnologyNameConflictError,
  ServiceTechnologyInUseError,
} from '@domain/errors/serviceTechnology';

export function createServiceTechnologiesRouter(
  authProvider: AuthProvider,
  listServiceTechnology: ListServiceTechnology,
  getServiceTechnology: GetServiceTechnology,
  createServiceTechnology: CreateServiceTechnology,
  updateServiceTechnology: UpdateServiceTechnology,
  deleteServiceTechnology: DeleteServiceTechnology,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  router.get('/service-technologies', auth, async (_req: Request, res: Response): Promise<void> => {
    res.json(await listServiceTechnology.execute());
  });

  router.get('/service-technologies/:id', auth, async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await getServiceTechnology.execute(req.params['id'] as string));
    } catch (err) {
      if (err instanceof ServiceTechnologyNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  router.post('/service-technologies', auth, async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateServiceTechnologySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.status(201).json(await createServiceTechnology.execute(parsed.data));
    } catch (err) {
      if (err instanceof ServiceTechnologyNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  router.put('/service-technologies/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateServiceTechnologySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await updateServiceTechnology.execute(req.params['id'] as string, parsed.data));
    } catch (err) {
      if (err instanceof ServiceTechnologyNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ServiceTechnologyNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  router.delete('/service-technologies/:id', auth, async (req: Request, res: Response): Promise<void> => {
    try {
      await deleteServiceTechnology.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof ServiceTechnologyNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ServiceTechnologyInUseError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  return router;
}
