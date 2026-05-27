import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { ListTasks } from '@application/use-cases/ListTasks';
import { GetTask } from '@application/use-cases/GetTask';
import { CreateTask } from '@application/use-cases/CreateTask';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { DeleteTask } from '@application/use-cases/DeleteTask';
import { MoveTaskToStage } from '@application/use-cases/MoveTaskToStage';
import { AddChecklistItem } from '@application/use-cases/AddChecklistItem';
import { ToggleChecklistItem } from '@application/use-cases/ToggleChecklistItem';
import { UpdateChecklistItem } from '@application/use-cases/UpdateChecklistItem';
import { RemoveChecklistItem } from '@application/use-cases/RemoveChecklistItem';
import { ReorderChecklistItems } from '@application/use-cases/ReorderChecklistItems';
import { AssignTemplateToTask } from '@application/use-cases/AssignTemplateToTask';
import { ClearTaskChecklist } from '@application/use-cases/ClearTaskChecklist';
import { SetTaskInventoryReview } from '@application/use-cases/SetTaskInventoryReview';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { StageRepository } from '@domain/ports/StageRepository';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  MoveStageSchema,
  ListTasksFilterSchema,
} from '@application/dto/scheduling.dto';
import {
  AddChecklistItemSchema,
  UpdateChecklistItemSchema,
  ReorderChecklistSchema,
  AssignTemplateSchema,
} from '@application/dto/checklists.dto';
import {
  StageNotFoundError,
  TaskNotFoundError,
  ReferenceNotFoundError,
  ReferenceKind,
} from '@domain/errors/scheduling';
import {
  ChecklistItemNotFoundError,
  TemplateNotFoundError,
  OrderingError,
} from '@domain/errors/checklist';

const REFERENCE_TO_CODE: Record<ReferenceKind, string> = {
  customer: 'CUSTOMER_NOT_FOUND',
  service:  'SERVICE_NOT_FOUND',
  partner:  'PARTNER_NOT_FOUND',
  reporter: 'REPORTER_NOT_FOUND',
  assignee: 'ASSIGNEE_NOT_FOUND',
  watcher:  'WATCHER_NOT_FOUND',
};

export interface ChecklistUseCases {
  addChecklistItem: AddChecklistItem;
  toggleChecklistItem: ToggleChecklistItem;
  updateChecklistItem: UpdateChecklistItem;
  removeChecklistItem: RemoveChecklistItem;
  reorderChecklistItems: ReorderChecklistItems;
  assignTemplateToTask: AssignTemplateToTask;
  clearTaskChecklist: ClearTaskChecklist;
}

export function createSchedulingRouter(
  listTasks: ListTasks,
  getTask: GetTask,
  createTask: CreateTask,
  updateTask: UpdateTask,
  deleteTask: DeleteTask,
  moveTaskToStage: MoveTaskToStage,
  authProvider: AuthProvider,
  stageRepo?: StageRepository,
  checklist?: ChecklistUseCases,
  setTaskInventoryReview?: SetTaskInventoryReview,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  router.get('/', auth, async (req: Request, res: Response): Promise<void> => {
    // Wire format: frontend sends ?stageIds[]=a&stageIds[]=b
    // Express 4 uses `qs` internally and auto-strips bracket notation:
    //   ?stageIds[]=a&stageIds[]=b → req.query.stageIds = ['a', 'b']
    // We normalise to array if a single string was provided.
    const rawStageIds = req.query['stageIds'];
    const stageIds = rawStageIds === undefined
      ? undefined
      : Array.isArray(rawStageIds)
        ? rawStageIds as string[]
        : [rawStageIds as string];

    const rawQuery = {
      projectId:  req.query['projectId'],
      stageIds,
      customerId: req.query['customerId'],
      partnerId:  req.query['partnerId'],
      assigneeId: req.query['assigneeId'],
      priority:   req.query['priority'],
      q:          req.query['q'],
      from:       req.query['from'],
      to:         req.query['to'],
      isClosed:   req.query['isClosed'],
    };

    const parsed = ListTasksFilterSchema.safeParse(rawQuery);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }

    const tasks = await listTasks.execute(parsed.data);
    res.json(tasks);
  });

  // ── Checklist sub-routes — MUST be registered BEFORE /:id to avoid shadowing ──

  if (checklist) {
    // POST /:id/checklist — add ad-hoc item
    router.post('/:id/checklist', auth, async (req: Request, res: Response): Promise<void> => {
      const parsed = AddChecklistItemSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      const item = await checklist.addChecklistItem.execute(req.params['id'] as string, parsed.data.text);
      if (!item) {
        res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
        return;
      }
      res.status(201).json(item);
    });

    // POST /:id/checklist/assign-template — MUST come before /:id/checklist/:itemId
    router.post('/:id/checklist/assign-template', auth, async (req: Request, res: Response): Promise<void> => {
      const parsed = AssignTemplateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const items = await checklist.assignTemplateToTask.execute(req.params['id'] as string, parsed.data.templateId);
        res.json(items);
      } catch (err) {
        if (err instanceof TemplateNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    });

    // DELETE /:id/checklist — clear all items
    router.delete('/:id/checklist', auth, async (req: Request, res: Response): Promise<void> => {
      await checklist.clearTaskChecklist.execute(req.params['id'] as string);
      res.status(204).send();
    });

    // PUT /:id/checklist/order — reorder items — MUST come before /:id/checklist/:itemId
    router.put('/:id/checklist/order', auth, async (req: Request, res: Response): Promise<void> => {
      const parsed = ReorderChecklistSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const items = await checklist.reorderChecklistItems.execute(req.params['id'] as string, parsed.data.orderedIds);
        res.json(items);
      } catch (err) {
        if (err instanceof OrderingError) {
          res.status(400).json({ error: err.message, code: 'VALIDATION_ERROR' });
          return;
        }
        throw err;
      }
    });

    // PATCH /:id/checklist/:itemId/toggle — toggle done
    router.patch('/:id/checklist/:itemId/toggle', auth, async (req: Request, res: Response): Promise<void> => {
      try {
        const item = await checklist.toggleChecklistItem.execute(req.params['itemId'] as string);
        res.json(item);
      } catch (err) {
        if (err instanceof ChecklistItemNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    });

    // PATCH /:id/checklist/:itemId — update text
    router.patch('/:id/checklist/:itemId', auth, async (req: Request, res: Response): Promise<void> => {
      const parsed = UpdateChecklistItemSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const item = await checklist.updateChecklistItem.execute(req.params['itemId'] as string, parsed.data.text);
        res.json(item);
      } catch (err) {
        if (err instanceof ChecklistItemNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    });

    // DELETE /:id/checklist/:itemId — remove single item
    router.delete('/:id/checklist/:itemId', auth, async (req: Request, res: Response): Promise<void> => {
      const deleted = await checklist.removeChecklistItem.execute(req.params['itemId'] as string);
      if (!deleted) {
        res.status(404).json({ error: 'Checklist item not found', code: 'CHECKLIST_ITEM_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    });
  }

  // ── End checklist sub-routes ────────────────────────────────────────────

  // ── RV — Revisado por Inventario ─────────────────────────────────────────
  // MUST be registered BEFORE /:id to avoid Express routing it as /:id with id='*'
  if (setTaskInventoryReview) {
    router.patch('/:id/inventory-review', auth, async (req: Request, res: Response): Promise<void> => {
      const InventoryReviewSchema = z.object({ reviewed: z.boolean() });
      const parsed = InventoryReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const task = await setTaskInventoryReview.execute(req.params['id'] as string, parsed.data.reviewed);
        res.json(task);
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    });
  }

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
      stageId,
      priority: data.priority,
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
