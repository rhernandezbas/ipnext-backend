import { Router, Request, Response, RequestHandler } from 'express';
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
  auth: RequestHandler,
  listTaskCategory: ListTaskCategory,
  getTaskCategory: GetTaskCategory,
  createTaskCategory: CreateTaskCategory,
  updateTaskCategory: UpdateTaskCategory,
  deleteTaskCategory: DeleteTaskCategory,
): Router {
  const router = Router();

  router.get('/task-categories', auth, async (_req: Request, res: Response): Promise<void> => {
    res.json(await listTaskCategory.execute());
  });

  router.get('/task-categories/:id', auth, async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await getTaskCategory.execute(req.params['id'] as string));
    } catch (err) {
      if (err instanceof TaskCategoryNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  router.post('/task-categories', auth, async (req: Request, res: Response): Promise<void> => {
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
      throw err;
    }
  });

  router.put('/task-categories/:id', auth, async (req: Request, res: Response): Promise<void> => {
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
      throw err;
    }
  });

  router.delete('/task-categories/:id', auth, async (req: Request, res: Response): Promise<void> => {
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
      throw err;
    }
  });

  return router;
}
