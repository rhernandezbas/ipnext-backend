import { Router, Request, Response, NextFunction } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListContractTechnology } from '@application/use-cases/ListContractTechnology';
import { GetContractTechnology } from '@application/use-cases/GetContractTechnology';
import { CreateContractTechnology } from '@application/use-cases/CreateContractTechnology';
import { UpdateContractTechnology } from '@application/use-cases/UpdateContractTechnology';
import { DeleteContractTechnology } from '@application/use-cases/DeleteContractTechnology';
import { CreateContractTechnologySchema, UpdateContractTechnologySchema } from '@application/dto/contractTechnology.dto';
import {
  ContractTechnologyNotFoundError,
  ContractTechnologyNameConflictError,
  ContractTechnologyInUseError,
} from '@domain/errors/contractTechnology';

// AD-3 DECISION (apply-time): mount path moves from /service-technologies → /contract-technologies.
// The FE does NOT consume a standalone catalog endpoint under the old name (as confirmed in AD-3).
// This URL move is part of the lockstep rename; coordinated with the FE change.
export function createContractTechnologiesRouter(
  authProvider: AuthProvider,
  listContractTechnology: ListContractTechnology,
  getContractTechnology: GetContractTechnology,
  createContractTechnology: CreateContractTechnology,
  updateContractTechnology: UpdateContractTechnology,
  deleteContractTechnology: DeleteContractTechnology,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  router.get('/contract-technologies', auth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await listContractTechnology.execute());
    } catch (err) {
      next(err);
    }
  });

  router.get('/contract-technologies/:id', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getContractTechnology.execute(req.params['id'] as string));
    } catch (err) {
      if (err instanceof ContractTechnologyNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.post('/contract-technologies', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateContractTechnologySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.status(201).json(await createContractTechnology.execute(parsed.data));
    } catch (err) {
      if (err instanceof ContractTechnologyNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.put('/contract-technologies/:id', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateContractTechnologySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await updateContractTechnology.execute(req.params['id'] as string, parsed.data));
    } catch (err) {
      if (err instanceof ContractTechnologyNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ContractTechnologyNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.delete('/contract-technologies/:id', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await deleteContractTechnology.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof ContractTechnologyNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ContractTechnologyInUseError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  return router;
}
