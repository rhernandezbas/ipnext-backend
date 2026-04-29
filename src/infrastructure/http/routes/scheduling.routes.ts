import { Router, Request, Response } from 'express';
import { ListTasks } from '@application/use-cases/ListTasks';
import { GetTask } from '@application/use-cases/GetTask';
import { CreateTask } from '@application/use-cases/CreateTask';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { DeleteTask } from '@application/use-cases/DeleteTask';
import { UpdateTaskStatus } from '@application/use-cases/UpdateTaskStatus';
import { ScheduledTask, TaskStatus } from '@domain/entities/scheduling';

export function createSchedulingRouter(
  listTasks: ListTasks,
  getTask: GetTask,
  createTask: CreateTask,
  updateTask: UpdateTask,
  deleteTask: DeleteTask,
  updateTaskStatus: UpdateTaskStatus,
): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    const tasks = await listTasks.execute();
    res.json(tasks);
  });

  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const task = await getTask.execute(req.params['id'] as string);
    if (!task) {
      res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
      return;
    }
    res.json(task);
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const task = await createTask.execute(req.body as Omit<ScheduledTask, 'id'>);
    res.status(201).json(task);
  });

  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    const task = await updateTask.execute(req.params['id'] as string, req.body as Partial<ScheduledTask>);
    if (!task) {
      res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
      return;
    }
    res.json(task);
  });

  router.patch('/:id/status', async (req: Request, res: Response): Promise<void> => {
    const { status } = req.body as { status: TaskStatus };
    const task = await updateTaskStatus.execute(req.params['id'] as string, status);
    if (!task) {
      res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
      return;
    }
    res.json(task);
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteTask.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
