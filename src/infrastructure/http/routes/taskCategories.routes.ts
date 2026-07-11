import { Router, Request, Response, NextFunction } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListTaskCategory } from '@application/use-cases/ListTaskCategory';
import { GetTaskCategory } from '@application/use-cases/GetTaskCategory';
import { CreateTaskCategory } from '@application/use-cases/CreateTaskCategory';
import { UpdateTaskCategory } from '@application/use-cases/UpdateTaskCategory';
import { DeleteTaskCategory } from '@application/use-cases/DeleteTaskCategory';
import { CreateTaskCategorySchema, UpdateTaskCategorySchema } from '@application/dto/scheduling.dto';
import {
  TaskCategoryNotFoundError,
  TaskCategoryNameConflictError,
  TaskCategoryInUseError,
} from '@domain/errors/scheduling';

export function createTaskCategoriesRouter(
  authProvider: AuthProvider,
  listTaskCategory: ListTaskCategory,
  getTaskCategory: GetTaskCategory,
  createTaskCategory: CreateTaskCategory,
  updateTaskCategory: UpdateTaskCategory,
  deleteTaskCategory: DeleteTaskCategory,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  router.get('/task-categories', auth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await listTaskCategory.execute());
    } catch (err) {
      next(err);
    }
  });

  router.get('/task-categories/:id', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getTaskCategory.execute(req.params['id'] as string));
    } catch (err) {
      if (err instanceof TaskCategoryNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.post('/task-categories', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateTaskCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.status(201).json(await createTaskCategory.execute(parsed.data));
    } catch (err) {
      if (err instanceof TaskCategoryNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.put('/task-categories/:id', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateTaskCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await updateTaskCategory.execute(req.params['id'] as string, parsed.data));
    } catch (err) {
      if (err instanceof TaskCategoryNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof TaskCategoryNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.delete('/task-categories/:id', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await deleteTaskCategory.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof TaskCategoryNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof TaskCategoryInUseError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  return router;
}
