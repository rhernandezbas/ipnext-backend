import { Router, Request, Response } from 'express';
import { ListTasks } from '@application/use-cases/ListTasks';
import { GetTask } from '@application/use-cases/GetTask';
import { CreateTask } from '@application/use-cases/CreateTask';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { DeleteTask } from '@application/use-cases/DeleteTask';
import { UpdateTaskStatus } from '@application/use-cases/UpdateTaskStatus';
import { MoveTaskToStage } from '@application/use-cases/MoveTaskToStage';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { StageRepository } from '@domain/ports/StageRepository';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  UpdateStatusSchema,
  MoveStageSchema,
} from '@application/dto/scheduling.dto';
import {
  StageNotFoundError,
  TaskNotFoundError,
  ReferenceNotFoundError,
  ReferenceKind,
} from '@domain/errors/scheduling';

const REFERENCE_TO_CODE: Record<ReferenceKind, string> = {
  customer: 'CUSTOMER_NOT_FOUND',
  service:  'SERVICE_NOT_FOUND',
  partner:  'PARTNER_NOT_FOUND',
  reporter: 'REPORTER_NOT_FOUND',
  assignee: 'ASSIGNEE_NOT_FOUND',
  watcher:  'WATCHER_NOT_FOUND',
};

export function createSchedulingRouter(
  listTasks: ListTasks,
  getTask: GetTask,
  createTask: CreateTask,
  updateTask: UpdateTask,
  deleteTask: DeleteTask,
  updateTaskStatus: UpdateTaskStatus,
  moveTaskToStage: MoveTaskToStage,
  authProvider: AuthProvider,
  stageRepo?: StageRepository,
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
    const data = parsed.data;

    // Resolve default stageId: if stageRepo is injected, look up the real "Nuevo" stage UUID.
    let stageId = data.stageId;
    if (!stageId) {
      if (stageRepo) {
        const defaultStage = await stageRepo.getDefaultWorkflowStageByLegacyStatus('pending');
        if (!defaultStage) {
          res.status(500).json({ error: 'Default workflow not seeded', code: 'INTERNAL_ERROR' });
          return;
        }
        stageId = defaultStage.id;
      } else {
        stageId = '10000000-0000-4000-a000-000000000001';
      }
    }

    const normalized = {
      title: data.title,
      description: data.description ?? null,
      assignedTo: data.assignedTo ?? null,
      assignedToId: data.assignedToId ?? null,
      clientId: data.clientId ?? null,
      clientName: data.clientName ?? null,
      stageId,
      priority: data.priority,
      scheduledDate: data.scheduledDate ?? null,
      scheduledTime: data.scheduledTime ?? null,
      estimatedHours: data.estimatedHours,
      address: data.address ?? null,
      coordinates: data.coordinates ?? null,
      category: data.category,
      projectId: data.projectId ?? null,
      projectName: data.projectName ?? null,
      completedAt: data.completedAt ?? null,
      notes: data.notes ?? null,
      // NEW fields
      startDate: data.startDate ?? null,
      endDate: data.endDate ?? null,
      customerId: data.customerId ?? null,
      serviceId: data.serviceId ?? null,
      partnerId: data.partnerId ?? null,
      reporterId: data.reporterId ?? null,
      assigneeId: data.assigneeId ?? null,
      watcherIds: data.watcherIds ?? [],
      travelTimeTo: data.travelTimeTo ?? null,
      travelTimeFrom: data.travelTimeFrom ?? null,
    };

    try {
      const task = await createTask.execute(normalized);
      res.status(201).json(task);
    } catch (err: unknown) {
      if (err instanceof ReferenceNotFoundError) {
        res.status(404).json({ error: err.message, code: REFERENCE_TO_CODE[err.kind] });
        return;
      }
      if (err instanceof StageNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  router.put('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }

    try {
      const task = await updateTask.execute(req.params['id'] as string, parsed.data);
      if (!task) {
        res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
        return;
      }
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof ReferenceNotFoundError) {
        res.status(404).json({ error: err.message, code: REFERENCE_TO_CODE[err.kind] });
        return;
      }
      throw err;
    }
  });

  // NEW: move to stage
  router.patch('/:id/stage', auth, async (req: Request, res: Response): Promise<void> => {
    const parsed = MoveStageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const task = await moveTaskToStage.execute(req.params['id'] as string, parsed.data.stageId);
      res.json(task);
    } catch (err: unknown) {
      if (err instanceof StageNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof TaskNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  // DEPRECATED: kept for one release as an alias
  router.patch('/:id/status', auth, async (req: Request, res: Response): Promise<void> => {
    console.warn('deprecated route: PATCH /api/scheduling/:id/status — use /:id/stage instead');
    const parsed = UpdateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    const task = await updateTaskStatus.execute(req.params['id'] as string, parsed.data.status);
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
