import { Router, Request, Response } from 'express';
import { ListTasks } from '@application/use-cases/ListTasks';
import { GetTask } from '@application/use-cases/GetTask';
import { CreateTask } from '@application/use-cases/CreateTask';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { DeleteTask } from '@application/use-cases/DeleteTask';
import { UpdateTaskStatus } from '@application/use-cases/UpdateTaskStatus';
import { ScheduledTask, TaskStatus } from '@domain/entities/scheduling';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { CreateTaskSchema, UpdateTaskSchema, UpdateStatusSchema } from '@application/dto/scheduling.dto';

export function createSchedulingRouter(
  listTasks: ListTasks,
  getTask: GetTask,
  createTask: CreateTask,
  updateTask: UpdateTask,
  deleteTask: DeleteTask,
  updateTaskStatus: UpdateTaskStatus,
  authProvider: AuthProvider,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  router.get('/', auth, async (_req: Request, res: Response): Promise<void> => {
    const tasks = await listTasks.execute();
    res.json(tasks);
  });

  router.get('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const task = await getTask.execute(req.params['id'] as string);
    if (!task) {
      res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
      return;
    }
    res.json(task);
  });

  router.post('/', auth, async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    const normalized = {
      ...parsed.data,
      projectId: parsed.data.projectId ?? null,
      projectName: parsed.data.projectName ?? null,
    };
    const task = await createTask.execute(normalized as Omit<ScheduledTask, 'id'>);
    res.status(201).json(task);
  });

  router.put('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    const task = await updateTask.execute(req.params['id'] as string, parsed.data as Partial<ScheduledTask>);
    if (!task) {
      res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
      return;
    }
    res.json(task);
  });

  router.patch('/:id/status', auth, async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    const { status } = parsed.data as { status: TaskStatus };
    const task = await updateTaskStatus.execute(req.params['id'] as string, status);
    if (!task) {
      res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
      return;
    }
    res.json(task);
  });

  router.delete('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteTask.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
