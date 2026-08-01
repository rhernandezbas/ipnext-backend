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
import { CloseIClassServiceOrder } from '@application/use-cases/CloseIClassServiceOrder';
import { AssignIClassTeam } from '@application/use-cases/AssignIClassTeam';
import { CloseActionSchema, AssignTeamSchema } from '@application/dto/iclassServiceOrderAction.dto';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { StageRepository } from '@domain/ports/StageRepository';
import { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import type { SessionRepository } from '@domain/ports/SessionRepository';
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
  TaskNotClosedError,
  InvalidCursorError,
  InvalidGeneralStatusError,
  ReferenceNotFoundError,
  ReferenceKind,
  ProjectKindMismatchError,
  NetworkTaskAddressRequiredError,
  NetworkTaskLocalityRequiredError,
  NetworkTaskNodeNameRequiredError,
  NetworkTypeImmutableError,
} from '@domain/errors/scheduling';
import {
  ChecklistItemNotFoundError,
  TemplateNotFoundError,
  OrderingError,
} from '@domain/errors/checklist';
import { RetireContractEquipment } from '@application/use-cases/RetireContractEquipment';
import { ArchiveTask } from '@application/use-cases/ArchiveTask';
import { BroadcastTaskToNoc } from '@application/use-cases/nocBroadcast/BroadcastTaskToNoc';
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
  // iclass-ops-config: SetTechnicianTeamMapping 404
  user:        'USER_NOT_FOUND',
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

/**
 * Ola A + B: IClass OS action use cases.
 * Injected as an optional bag into createSchedulingRouter to avoid expanding the
 * positional param list. Matches the same pattern as ResendDeps.
 */
export interface IClassActionDeps {
  closeIClassServiceOrder: CloseIClassServiceOrder;
  assignIClassTeam: AssignIClassTeam;
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
  sessionRepo: SessionRepository | undefined,
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
  /** #86 — use case for archiving a task. Optional — POST /:id/archive only registered when provided. */
  archiveTask?: ArchiveTask,
  /** #86 — guard for DELETE /:id (scheduling:hard_delete → super_admin only). Pass-through when omitted. */
  requireHardDelete?: RequestHandler,
  /** Ola A + B — IClass OS action use cases (close + assign-team). Optional — routes only registered when provided. */
  iclassActionDeps?: IClassActionDeps,
  /** N3 (network-task-broadcast) — "Send to WS" de una tarea de red al NOC. Optional — POST /:id/broadcast-noc solo se registra cuando se inyecta. Gated por scheduling:write (schedWrite). */
  broadcastTaskToNoc?: BroadcastTaskToNoc,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider, sessionRepo);
  const invWrite: RequestHandler = requireInventoryWrite ?? ((_req, _res, next) => next());
  const schedWrite: RequestHandler = requireSchedulingWrite ?? ((_req, _res, next) => next());
  const hardDelete: RequestHandler = requireHardDelete ?? ((_req, _res, next) => next());

  // Actor for the activity log (#10), derived from the authenticated user.
  const actorOf = (req: Request): ActorContext => ({
    actorId: req.user?.id ?? null,
    actorName: req.user?.username ?? 'System',
  });

  router.get('/', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
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
        // #86 — archived filter. Omitted → exclude archived. true → only archived.
        archived:   req.query['archived'],
      };

      const parsed = ListTasksFilterSchema.safeParse(rawQuery);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }

      const tasks = await listTasks.execute(parsed.data);
      res.json(tasks);
    } catch (err) {
      next(err);
    }
  });

  // ── Checklist sub-routes — MUST be registered BEFORE /:id to avoid shadowing ──

  if (checklist) {
    // POST /:id/checklist — add ad-hoc item
    router.post('/:id/checklist', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
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
      } catch (err) {
        next(err);
      }
    });

    // POST /:id/checklist/assign-template — MUST come before /:id/checklist/:itemId
    router.post('/:id/checklist/assign-template', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
        // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
        next(err);
      }
    });

    // DELETE /:id/checklist — clear all items
    router.delete('/:id/checklist', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        await checklist.clearTaskChecklist.execute(req.params['id'] as string, actorOf(req));
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    });

    // PUT /:id/checklist/order — reorder items — MUST come before /:id/checklist/:itemId
    router.put('/:id/checklist/order', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
        // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
        next(err);
      }
    });

    // PATCH /:id/checklist/:itemId/toggle — toggle done
    router.patch('/:id/checklist/:itemId/toggle', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const item = await checklist.toggleChecklistItem.execute(req.params['itemId'] as string, actorOf(req));
        res.json(item);
      } catch (err) {
        if (err instanceof ChecklistItemNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
        next(err);
      }
    });

    // PATCH /:id/checklist/:itemId — update text
    router.patch('/:id/checklist/:itemId', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
        // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
        next(err);
      }
    });

    // DELETE /:id/checklist/:itemId — remove single item
    router.delete('/:id/checklist/:itemId', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const deleted = await checklist.removeChecklistItem.execute(req.params['itemId'] as string, req.params['id'] as string, actorOf(req));
        if (!deleted) {
          res.status(404).json({ error: 'Checklist item not found', code: 'CHECKLIST_ITEM_NOT_FOUND' });
          return;
        }
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    });
  }

  // ── End checklist sub-routes ────────────────────────────────────────────

  // ── RV — Revisado por Inventario ─────────────────────────────────────────
  // MUST be registered BEFORE /:id to avoid Express routing it as /:id with id='*'
  if (setTaskInventoryReview) {
    router.patch('/:id/inventory-review', auth, invWrite, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
        // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
        next(err);
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

    router.post('/bulk/stage', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const parsed = BulkMoveSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }
        const result = await bulkMoveTasksToStage.execute(parsed.data.ids, parsed.data.stageId, actorOf(req));
        res.json(result);
      } catch (err) {
        next(err);
      }
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
          req.user?.id ?? null,
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

  // ── IClass OS action routes (Ola A + B) ──────────────────────────────────
  // MUST be registered BEFORE /:id to avoid route shadowing.
  if (iclassActionDeps) {
    const { closeIClassServiceOrder, assignIClassTeam, requirePerm: reqPerm } = iclassActionDeps;
    const closePerm = reqPerm('scheduling', 'iclass_close');
    const assignPerm = reqPerm('scheduling', 'iclass_assign');

    // POST /api/scheduling/:id/iclass/close (R1-R7)
    router.post('/:id/iclass/close', auth, closePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const parsed = CloseActionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const closeDate = parsed.data.closeDate ? new Date(parsed.data.closeDate) : undefined;
        const task = await closeIClassServiceOrder.execute({
          taskId: req.params['id'] as string,
          resultCode: parsed.data.resultCode,
          commentary: parsed.data.commentary,
          closeDate,
          actorId: req.user?.id ?? null,
        });
        res.status(200).json(task);
      } catch (err) {
        next(err);
      }
    });

    // POST /api/scheduling/:id/iclass/assign-team (R8-R9)
    router.post('/:id/iclass/assign-team', auth, assignPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const parsed = AssignTeamSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      try {
        const task = await assignIClassTeam.execute({
          taskId: req.params['id'] as string,
          teamLogin: parsed.data.teamLogin,
          actorId: req.user?.id ?? null,
        });
        res.status(200).json(task);
      } catch (err) {
        next(err);
      }
    });
  }

  // ── End iclass OS action routes ───────────────────────────────────────────

  // Activity feed (#10). MUST be registered BEFORE GET /:id so the extra
  // `/activity` segment is not shadowed by the catch-all id route.
  if (getTaskActivity) {
    router.get('/:id/activity', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
        // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
        next(err);
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
          actorId: req.user?.id ?? null,
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

    router.post('/:id/status', auth, schedWrite, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
        // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
        next(err);
      }
    });
  }

  // ── End general status ────────────────────────────────────────────────────

  // ── #86 — Archive task ────────────────────────────────────────────────────
  // MUST be registered BEFORE GET /:id so the catch-all id route does not shadow it.
  // Gated by auth + scheduling:write (schedWrite is pass-through when omitted).
  if (archiveTask) {
    router.post('/:id/archive', auth, schedWrite, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const task = await archiveTask.execute(req.params['id'] as string);
        res.status(200).json(task);
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof TaskNotClosedError) {
          res.status(422).json({ error: err.message, code: err.code });
          return;
        }
        // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
        next(err);
      }
    });
  }

  // ── End archive ───────────────────────────────────────────────────────────

  // ── N3 — Send to WS: difundir una tarea de RED al canal NOC ───────────────
  // MUST be registered BEFORE GET /:id so el catch-all no la ensombrezca.
  // Gated por auth + scheduling:write (schedWrite es pass-through si se omite),
  // el MISMO permiso que gobierna las mutaciones de tarea (status/archive).
  // NOT best-effort: los errores del motor N1 (503 no configurado, 502 Evolution,
  // 422 link base) y del dominio (404 TASK_NOT_FOUND, 422 TASK_NOT_BROADCASTABLE)
  // burbujean al errorHandler global vía next(err).
  if (broadcastTaskToNoc) {
    router.post('/:id/broadcast-noc', auth, schedWrite, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const result = await broadcastTaskToNoc.execute(req.params['id'] as string, actorOf(req));
        res.status(200).json(result);
      } catch (err) {
        // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
        next(err);
      }
    });
  }

  // ── End Send to WS ────────────────────────────────────────────────────────

  router.get('/:id', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const task = await getTask.execute(req.params['id'] as string);
      if (!task) {
        res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
        return;
      }
      res.json(task);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      // #66 — The hybrid fibra+site shape is a semantic conflict, not a malformed
      // body: map it to 422 FIBRA_TASK_NO_SITE (the DTO superRefine tags it via
      // params.fibraTaskNoSite). Any other failure stays a generic 400.
      const fibraNoSite = parsed.error.issues.some(
        (i) => (i as { params?: { fibraTaskNoSite?: boolean } }).params?.fibraTaskNoSite === true,
      );
      if (fibraNoSite) {
        res.status(422).json({ error: 'Fibra network tasks must not carry a networkSiteId', code: 'FIBRA_TASK_NO_SITE' });
        return;
      }
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    const data = parsed.data;

    // Resolve default stageId: if stageRepo is injected, look up the real "Nuevo" stage UUID.
    let stageId = data.stageId;
    if (!stageId) {
      if (stageRepo) {
        // async-error-sweep-2: este await corría FUERA del try de abajo — si el
        // lookup rechazaba (infra caída) la request quedaba COLGADA (504).
        try {
          const defaultStage = await stageRepo.getDefaultWorkflowStageByLegacyStatus('pending');
          if (!defaultStage) {
            res.status(500).json({ error: 'Default workflow not seeded', code: 'INTERNAL_ERROR' });
            return;
          }
          stageId = defaultStage.id;
        } catch (err) {
          next(err);
          return;
        }
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
      // #66 — Red/FO switch
      networkType: ('networkType' in data ? (data as { networkType?: 'red' | 'fibra' | null }).networkType : null) ?? null,
      networkSiteId: ('networkSiteId' in data ? data.networkSiteId : null) ?? null,
      // #66 — free-text node name for fibra tasks
      networkSiteName: ('networkSiteName' in data ? (data as { networkSiteName?: string | null }).networkSiteName : null) ?? null,
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
      // #66 — fibra task requires a non-blank networkSiteName (node name).
      if (err instanceof NetworkTaskNodeNameRequiredError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  // SECURITY (K3-FE review CRITICAL): onuSerial arms the fiber-auto-provision
  // watcher — it auto-provisions REAL ONUs with no human in the loop. This PUT
  // historically only had `auth` (no permission at all), and the FE gate on
  // scheduling.write is cosmetic (bypassable via direct API call). Surgical
  // fix: do NOT gate the whole route — operators edit title/address/assignee
  // daily and that flow never required a permission; gating everything would
  // break live flows. Instead, ONLY when the body carries the `onuSerial` key
  // (present, even null — clearing also arms/disarms it) do we require
  // scheduling:write via the same schedWrite guard used by
  // POST /:id/status and /:id/archive. No key present → pass-through,
  // byte-identical to the pre-fix behaviour.
  const onuSerialPermGate: RequestHandler = (req, res, next) => {
    if (req.body && typeof req.body === 'object' && 'onuSerial' in req.body) {
      schedWrite(req, res, next);
      return;
    }
    next();
  };

  router.put('/:id', auth, onuSerialPermGate, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
      // #66 — fibra task requires a non-blank networkSiteName on update.
      if (err instanceof NetworkTaskNodeNameRequiredError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      // #66 — networkType is immutable post-create.
      if (err instanceof NetworkTypeImmutableError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
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

  // #86 — hard_delete guard: only super_admin (via requirePerm('scheduling','hard_delete')).
  // hardDelete is a pass-through when omitted (back-compat for tests without guard wired).
  router.delete('/:id', auth, hardDelete, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const deleted = await deleteTask.execute(req.params['id'] as string);
      if (!deleted) {
        res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
