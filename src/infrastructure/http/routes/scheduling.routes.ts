import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { ListTasks } from '@application/use-cases/ListTasks';
import { GetTask } from '@application/use-cases/GetTask';
import { GetTaskActivity } from '@application/use-cases/GetTaskActivity';
import { ActorContext } from '@domain/ports/TaskActivityRecorder';
import { CreateTask } from '@application/use-cases/CreateTask';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { DeleteTask } from '@application/use-cases/DeleteTask';
import { MoveTaskToStage } from '@application/use-cases/MoveTaskToStage';
import { BulkMoveTasksToStage } from '@application/use-cases/BulkMoveTasksToStage';
import { AddChecklistItem } from '@application/use-cases/AddChecklistItem';
import { ToggleChecklistItem } from '@application/use-cases/ToggleChecklistItem';
import { UpdateChecklistItem } from '@application/use-cases/UpdateChecklistItem';
import { RemoveChecklistItem } from '@application/use-cases/RemoveChecklistItem';
import { ReorderChecklistItems } from '@application/use-cases/ReorderChecklistItems';
import { AssignTemplateToTask } from '@application/use-cases/AssignTemplateToTask';
import { ClearTaskChecklist } from '@application/use-cases/ClearTaskChecklist';
import { SetTaskInventoryReview } from '@application/use-cases/SetTaskInventoryReview';
import { SetTaskGeneralStatus } from '@application/use-cases/SetTaskGeneralStatus';
import { ListIClassNodes } from '@application/use-cases/ListIClassNodes';
import { ResendTaskToIClassWithNode } from '@application/use-cases/ResendTaskToIClassWithNode';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { StageRepository } from '@domain/ports/StageRepository';
import { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
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
  InvalidCursorError,
  InvalidGeneralStatusError,
  ReferenceNotFoundError,
  ReferenceKind,
  ProjectKindMismatchError,
  NetworkTaskAddressRequiredError,
  NetworkTaskLocalityRequiredError,
} from '@domain/errors/scheduling';
import {
  ChecklistItemNotFoundError,
  TemplateNotFoundError,
  OrderingError,
} from '@domain/errors/checklist';
import { RetireContractEquipment } from '@application/use-cases/RetireContractEquipment';
import {
  TaskHasNoContractError,
  ProjectNotRetirementError,
  EquipmentNotOnContractError,
  RetireAlreadyDoneError,
} from '@domain/errors/inventory';

const REFERENCE_TO_CODE: Record<ReferenceKind, string> = {
  customer:    'CUSTOMER_NOT_FOUND',
  contract:    'CONTRACT_NOT_FOUND',
  partner:     'PARTNER_NOT_FOUND',
  project:     'PROJECT_NOT_FOUND',
  reporter:    'REPORTER_NOT_FOUND',
  assignee:    'ASSIGNEE_NOT_FOUND',
  watcher:     'WATCHER_NOT_FOUND',
  ticket:      'TICKET_NOT_FOUND',
  // network-node-task (#29): REQ-REF-NETWORK-1
  networkSite: 'NETWORK_SITE_NOT_FOUND',
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

export interface ResendDeps {
  listIClassNodes: ListIClassNodes;
  resendTaskToIClassWithNode: ResendTaskToIClassWithNode;
  requirePerm: (m: RbacModuleCode, a: PermissionAction) => RequestHandler;
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
  bulkMoveTasksToStage?: BulkMoveTasksToStage,
  resendDeps?: ResendDeps,
  getTaskActivity?: GetTaskActivity,
  /** Granular guard for the inventory-review mutation (inventory:write). Defaults
   * to a pass-through only when omitted (legacy callers/tests) — app.ts injects it. */
  requireInventoryWrite?: RequestHandler,
  /** Use case for manual equipment retirement (#39). Optional — route only registered when provided. */
  retireContractEquipment?: RetireContractEquipment,
  /** #41 — use case for the general-status mutation. Optional — POST /:id/status only registered when provided. */
  setTaskGeneralStatus?: SetTaskGeneralStatus,
  /** #41 — granular guard for the general-status mutation (scheduling:write). Pass-through when omitted. */
  requireSchedulingWrite?: RequestHandler,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);
  const invWrite: RequestHandler = requireInventoryWrite ?? ((_req, _res, next) => next());
  const schedWrite: RequestHandler = requireSchedulingWrite ?? ((_req, _res, next) => next());

  // Actor for the activity log (#10), derived from the authenticated user.
  const actorOf = (req: Request): ActorContext => ({
    actorId: req.user?.id ?? null,
    actorName: req.user?.username ?? 'System',
  });

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
      kind:       req.query['kind'],
      status:     req.query['status'],
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
      const item = await checklist.addChecklistItem.execute(req.params['id'] as string, parsed.data.text, actorOf(req));
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
        const items = await checklist.assignTemplateToTask.execute(req.params['id'] as string, parsed.data.templateId, actorOf(req));
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
      await checklist.clearTaskChecklist.execute(req.params['id'] as string, actorOf(req));
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
        const items = await checklist.reorderChecklistItems.execute(req.params['id'] as string, parsed.data.orderedIds, actorOf(req));
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
        const item = await checklist.toggleChecklistItem.execute(req.params['itemId'] as string, actorOf(req));
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
        const item = await checklist.updateChecklistItem.execute(req.params['itemId'] as string, parsed.data.text, actorOf(req));
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
      const deleted = await checklist.removeChecklistItem.execute(req.params['itemId'] as string, req.params['id'] as string, actorOf(req));
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
    router.patch('/:id/inventory-review', auth, invWrite, async (req: Request, res: Response): Promise<void> => {
      const InventoryReviewSchema = z.object({ reviewed: z.boolean() });
      const parsed = InventoryReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const actorId = (req as { user?: { id?: string } }).user?.id ?? null;
        const task = await setTaskInventoryReview.execute(req.params['id'] as string, parsed.data.reviewed, actorId, actorOf(req));
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

  // ── Bulk move N tasks to a stage ─────────────────────────────────────────
  // MUST be registered BEFORE /:id so the catch-all does not shadow it (AD-6).
  // Always responds 200 with a per-task result envelope (partial failures live
  // inside results[i], never as an HTTP error) — AD-3. Only invalid body → 400.
  if (bulkMoveTasksToStage) {
    const BulkMoveSchema = z.object({
      ids: z.array(z.string().min(1)).min(1),
      stageId: z.string().min(1),
    });

    router.post('/bulk/stage', auth, async (req: Request, res: Response): Promise<void> => {
      const parsed = BulkMoveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      const result = await bulkMoveTasksToStage.execute(parsed.data.ids, parsed.data.stageId, actorOf(req));
      res.json(result);
    });
  }

  // ── IClass manual resend routes ───────────────────────────────────────────
  // MUST be registered BEFORE /:id so Express does not shadow them with the
  // catch-all. Same gotcha as checklist/bulkMoveTasksToStage/inventory-review.
  if (resendDeps) {
    const { listIClassNodes, resendTaskToIClassWithNode, requirePerm } = resendDeps;
    const resendPerm = requirePerm('scheduling', 'iclass_manual_resend');

    // GET /api/scheduling/iclass/nodes  (REQ-NODES-1..4)
    router.get('/iclass/nodes', auth, resendPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const result = await listIClassNodes.execute();
        res.status(200).json(result);
      } catch (err) {
        // ICLASS_UNAVAILABLE bubbles to errorHandler (502)
        next(err);
      }
    });

    // POST /api/scheduling/:id/iclass/resend  (REQ-RESEND-1, REQ-RESEND-9)
    router.post('/:id/iclass/resend', auth, resendPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const ResendSchema = z.object({ nodeCode: z.string().min(1) });
      const parsed = ResendSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const task = await resendTaskToIClassWithNode.execute(
          req.params['id'] as string,
          parsed.data.nodeCode,
          (req as any).user?.id ?? null,
        );
        res.status(200).json(task);
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          res.status(404).json({ error: (err as TaskNotFoundError).message, code: (err as TaskNotFoundError).code });
          return;
        }
        // IClassNodeNotFoundError (422), IClassRejectedError (422),
        // IClassUnavailableError (502) → bubble to errorHandler
        next(err);
      }
    });
  }

  // ── End iclass resend routes ──────────────────────────────────────────────

  // Activity feed (#10). MUST be registered BEFORE GET /:id so the extra
  // `/activity` segment is not shadowed by the catch-all id route.
  if (getTaskActivity) {
    router.get('/:id/activity', auth, async (req: Request, res: Response): Promise<void> => {
      const rawLimit = req.query['limit'];
      const limit = rawLimit !== undefined ? parseInt(rawLimit as string, 10) : undefined;
      const cursor = req.query['cursor'] as string | undefined;
      try {
        const result = await getTaskActivity.execute(req.params['id'] as string, { limit, cursor });
        res.json(result);
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof InvalidCursorError) {
          res.status(400).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    });
  }

  // ── Manual equipment retirement (#39) ────────────────────────────────────
  // MUST be registered BEFORE GET /:id to avoid shadowing.
  if (retireContractEquipment) {
    const RetireSchema = z.object({ itemIds: z.array(z.string().min(1)).min(1, 'itemIds must contain at least one item') });

    router.post('/:id/inventory/retire', auth, invWrite, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const parsed = RetireSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const result = await retireContractEquipment.execute({
          taskId: req.params['id'] as string,
          itemIds: parsed.data.itemIds,
          actorId: (req as any).user?.id ?? null,
        });
        // Map internal result to wire contract: { retired: [{itemId, status, assetReturned}] }
        res.status(200).json({
          retired: result.retired.map(r => ({
            itemId: r.itemId,
            status: r.status,
            assetReturned: r.assetId !== null && r.movementId !== null,
          })),
        });
      } catch (err) {
        if (err instanceof TaskHasNoContractError) {
          res.status(422).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof ProjectNotRetirementError) {
          res.status(422).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof EquipmentNotOnContractError) {
          res.status(422).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof RetireAlreadyDoneError) {
          res.status(409).json({ error: err.message, code: err.code });
          return;
        }
        // FIX-4: P2002 from the partial-unique index (concurrent retire race condition).
        // Both concurrent requests pass the pre-write findBySourceRef check; the loser
        // hits the DB constraint and gets P2002. Map to 409 so the client retries gracefully.
        if ((err as any)?.code === 'P2002') {
          res.status(409).json({ error: 'This item has already been retired', code: 'RETIRE_ALREADY_DONE' });
          return;
        }
        next(err);
      }
    });
  }

  // ── End equipment retirement ──────────────────────────────────────────────

  // ── #41 — General status (open / closed / dismissed) ──────────────────────
  // MUST be registered BEFORE GET /:id so the catch-all id route does not shadow it.
  // Gated by auth + scheduling:write (schedWrite is pass-through when omitted).
  if (setTaskGeneralStatus) {
    const StatusSchema = z.object({ status: z.enum(['open', 'closed', 'dismissed']) });

    router.post('/:id/status', auth, schedWrite, async (req: Request, res: Response): Promise<void> => {
      const parsed = StatusSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const task = await setTaskGeneralStatus.execute(req.params['id'] as string, parsed.data.status, actorOf(req));
        res.status(200).json(task);
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof InvalidGeneralStatusError) {
          res.status(422).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    });
  }

  // ── End general status ────────────────────────────────────────────────────

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
      projectId: (data.projectId === '' ? null : data.projectId) ?? null, // REQ-CREATE-14: coerce empty-string to null
      projectName: data.projectName ?? null,
      completedAt: data.completedAt ?? null,
      notes: data.notes ?? null,
      // NEW fields
      startDate: data.startDate ?? null,
      endDate: data.endDate ?? null,
      customerId: data.customerId ?? null,
      contractId: data.contractId ?? null,
      partnerId: data.partnerId ?? null,
      // Default reporterId to the authenticated user when the body omits it
      // (REQ-CREATE-9/10/11). User.id == admin.id by construction in
      // JwtAuthAdapter, so the defaulted value passes CreateTask's FK validation
      // against adminLookup. An explicit body value still wins.
      reporterId: data.reporterId ?? req.user?.id ?? null,
      assigneeId: data.assigneeId ?? null,
      watcherIds: data.watcherIds ?? [],
      travelTimeTo: data.travelTimeTo ?? null,
      travelTimeFrom: data.travelTimeFrom ?? null,
      // network-node-task (#29): kind discriminator + networkSiteId
      kind: data.kind,
      networkSiteId: ('networkSiteId' in data ? data.networkSiteId : null) ?? null,
      // #54 — locality snapshot for network tasks
      iclassCityCode: (data as { iclassCityCode?: string | null }).iclassCityCode ?? null,
    };

    try {
      const task = await createTask.execute(normalized, actorOf(req));
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
      // #40 — project↔kind mismatch. Domain code is PROJECT_KIND_MISMATCH; the
      // frozen Wire Contract maps it to 422 with the wire code INVALID_PROJECT_KIND.
      if (err instanceof ProjectKindMismatchError) {
        res.status(422).json({ error: err.message, code: 'INVALID_PROJECT_KIND' });
        return;
      }
      // #53 — network task requires a non-blank address.
      if (err instanceof NetworkTaskAddressRequiredError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      // #54 — network task requires a non-blank iclassCityCode (locality).
      if (err instanceof NetworkTaskLocalityRequiredError) {
        res.status(422).json({ error: err.message, code: err.code });
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
      const task = await updateTask.execute(req.params['id'] as string, parsed.data, actorOf(req));
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
      // #40 — project↔kind mismatch on update. Same frozen Wire Contract as POST:
      // domain code PROJECT_KIND_MISMATCH maps to 422 INVALID_PROJECT_KIND.
      if (err instanceof ProjectKindMismatchError) {
        res.status(422).json({ error: err.message, code: 'INVALID_PROJECT_KIND' });
        return;
      }
      // #53 — network task requires a non-blank address on update.
      if (err instanceof NetworkTaskAddressRequiredError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      // #54 — network task requires a non-blank iclassCityCode on update.
      if (err instanceof NetworkTaskLocalityRequiredError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });

  // NEW: move to stage
  router.patch('/:id/stage', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = MoveStageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const task = await moveTaskToStage.execute(req.params['id'] as string, parsed.data.stageId, actorOf(req));
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
      // IClass integration errors (MISSING_REQUIRED_FIELDS, ICLASS_NODE_NOT_FOUND,
      // ICLASS_UNAVAILABLE) bubble up to the global error handler.
      next(err);
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
