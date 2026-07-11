import { Router, Request, Response, NextFunction } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListTaskPriority } from '@application/use-cases/ListTaskPriority';
import { GetTaskPriority } from '@application/use-cases/GetTaskPriority';
import { CreateTaskPriority } from '@application/use-cases/CreateTaskPriority';
import { UpdateTaskPriority } from '@application/use-cases/UpdateTaskPriority';
import { DeleteTaskPriority } from '@application/use-cases/DeleteTaskPriority';
import { CreateTaskPrioritySchema, UpdateTaskPrioritySchema } from '@application/dto/scheduling.dto';
import {
  TaskPriorityNotFoundError,
  TaskPriorityNameConflictError,
  TaskPriorityInUseError,
} from '@domain/errors/scheduling';

export function createTaskPrioritiesRouter(
  authProvider: AuthProvider,
  listTaskPriority: ListTaskPriority,
  getTaskPriority: GetTaskPriority,
  createTaskPriority: CreateTaskPriority,
  updateTaskPriority: UpdateTaskPriority,
  deleteTaskPriority: DeleteTaskPriority,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  router.get('/task-priorities', auth, async (_req: Request, res: Response): Promise<void> => {
    res.json(await listTaskPriority.execute());
  });

  router.get('/task-priorities/:id', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getTaskPriority.execute(req.params['id'] as string));
    } catch (err) {
      if (err instanceof TaskPriorityNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.post('/task-priorities', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateTaskPrioritySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.status(201).json(await createTaskPriority.execute(parsed.data));
    } catch (err) {
      if (err instanceof TaskPriorityNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.put('/task-priorities/:id', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateTaskPrioritySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await updateTaskPriority.execute(req.params['id'] as string, parsed.data));
    } catch (err) {
      if (err instanceof TaskPriorityNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof TaskPriorityNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.delete('/task-priorities/:id', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await deleteTaskPriority.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof TaskPriorityNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof TaskPriorityInUseError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  return router;
}
