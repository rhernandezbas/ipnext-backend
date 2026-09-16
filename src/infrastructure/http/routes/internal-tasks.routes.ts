import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { CreateTask } from '@application/use-cases/CreateTask';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { SetTaskGeneralStatus } from '@application/use-cases/SetTaskGeneralStatus';
import { SendTaskToIClass } from '@application/use-cases/SendTaskToIClass';
import { AssignIClassTeam } from '@application/use-cases/AssignIClassTeam';
import { CreateTaskSchema } from '@application/dto/scheduling.dto';
import { StageRepository } from '@domain/ports/StageRepository';
import {
  ReferenceNotFoundError,
  ReferenceKind,
  StageNotFoundError,
  ProjectKindMismatchError,
  NetworkTaskAddressRequiredError,
  NetworkTaskLocalityRequiredError,
  NetworkTaskNodeNameRequiredError,
  InvalidGeneralStatusError,
} from '@domain/errors/scheduling';

// Same wire mapping used by the authenticated scheduling router (scheduling.routes.ts) —
// ReferenceNotFoundError extends plain Error (not DomainError), so it never reaches the
// global errorHandler and must be mapped inline, here as there.
const REFERENCE_TO_CODE: Record<ReferenceKind, string> = {
  customer:    'CUSTOMER_NOT_FOUND',
  contract:    'CONTRACT_NOT_FOUND',
  partner:     'PARTNER_NOT_FOUND',
  project:     'PROJECT_NOT_FOUND',
  reporter:    'REPORTER_NOT_FOUND',
  assignee:    'ASSIGNEE_NOT_FOUND',
  watcher:     'WATCHER_NOT_FOUND',
  ticket:      'TICKET_NOT_FOUND',
  networkSite: 'NETWORK_SITE_NOT_FOUND',
  user:        'USER_NOT_FOUND',
};

export interface InternalTaskDeps {
  createTask: CreateTask;
  updateTask: UpdateTask;
  setTaskGeneralStatus: SetTaskGeneralStatus;
  sendTaskToIClass: SendTaskToIClass;
  /**
   * Assigns technician + schedule window to an IClass Service Order. Required
   * by POST /:id/send-to-iclass, which now mandates teamLogin + schedule.
   */
  assignIClassTeam: AssignIClassTeam;
  /**
   * Optional — when injected, POST / resolves a missing stageId to the real
   * "Nuevo" stage UUID (mirrors createSchedulingRouter's POST /). Omitted →
   * falls back to the same sentinel default used by the authenticated route
   * for callers/tests that never seeded a workflow.
   */
  stageRepo?: StageRepository;
}

const AssignSchema = z.object({ assigneeId: z.string().min(1).nullable() });
const StatusSchema = z.object({ status: z.enum(['open', 'closed', 'dismissed']) });
// send-to-iclass now REQUIRES technician + schedule window (bridge-cse): the caller
// must provide the full "create OS + assign team" package in one shot — there is no
// separate step to add the technician later from this internal router.
const SendToIClassSchema = z
  .object({
    targetStageId: z.string().min(1),
    workflowId: z.string().min(1).optional(),
    teamLogin: z.string().min(1),
    scheduleStart: z.coerce.date(),
    scheduleEnd: z.coerce.date(),
  })
  .refine((data) => data.scheduleEnd > data.scheduleStart, {
    message: 'scheduleEnd must be after scheduleStart',
    path: ['scheduleEnd'],
  });

/**
 * Purely internal router — NO auth middleware, NO API key, by explicit user decision.
 * Meant to be called only from trusted internal automation (never exposed to the
 * public internet). It reuses the SAME use-case instances wired for the authenticated
 * /api/scheduling router (app.ts) — no duplicated business logic, no duplicated DI.
 */
export function createInternalTaskRouter(deps: InternalTaskDeps): Router {
  const { createTask, updateTask, setTaskGeneralStatus, sendTaskToIClass, assignIClassTeam, stageRepo } = deps;
  const router = Router();

  router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
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

    let stageId = data.stageId;
    if (!stageId) {
      if (stageRepo) {
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
      projectId: (data.projectId === '' ? null : data.projectId) ?? null,
      projectName: data.projectName ?? null,
      completedAt: data.completedAt ?? null,
      notes: data.notes ?? null,
      startDate: data.startDate ?? null,
      endDate: data.endDate ?? null,
      customerId: data.customerId ?? null,
      contractId: data.contractId ?? null,
      partnerId: data.partnerId ?? null,
      reporterId: data.reporterId ?? null,
      assigneeId: data.assigneeId ?? null,
      watcherIds: data.watcherIds ?? [],
      travelTimeTo: data.travelTimeTo ?? null,
      travelTimeFrom: data.travelTimeFrom ?? null,
      kind: data.kind,
      networkType: ('networkType' in data ? (data as { networkType?: 'red' | 'fibra' | null }).networkType : null) ?? null,
      networkSiteId: ('networkSiteId' in data ? data.networkSiteId : null) ?? null,
      networkSiteName: ('networkSiteName' in data ? (data as { networkSiteName?: string | null }).networkSiteName : null) ?? null,
      iclassCityCode: (data as { iclassCityCode?: string | null }).iclassCityCode ?? null,
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
      if (err instanceof ProjectKindMismatchError) {
        res.status(422).json({ error: err.message, code: 'INVALID_PROJECT_KIND' });
        return;
      }
      if (err instanceof NetworkTaskAddressRequiredError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof NetworkTaskLocalityRequiredError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof NetworkTaskNodeNameRequiredError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      // Anything else (FibraTaskNoSiteError, etc.) is a DomainError already
      // mapped by the global errorHandler.
      next(err);
    }
  });

  router.patch('/:id/status', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = StatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const task = await setTaskGeneralStatus.execute(req.params['id'] as string, parsed.data.status);
      res.status(200).json(task);
    } catch (err: unknown) {
      if (err instanceof InvalidGeneralStatusError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      // TaskNotFoundError is a DomainError already mapped by the global errorHandler (404).
      next(err);
    }
  });

  router.post('/:id/assign', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = AssignSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const task = await updateTask.execute(req.params['id'] as string, { assigneeId: parsed.data.assigneeId });
      if (!task) {
        res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
        return;
      }
      res.status(200).json(task);
    } catch (err: unknown) {
      if (err instanceof ReferenceNotFoundError) {
        res.status(404).json({ error: err.message, code: REFERENCE_TO_CODE[err.kind] });
        return;
      }
      next(err);
    }
  });

  router.post('/:id/send-to-iclass', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = SendToIClassSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    const taskId = req.params['id'] as string;
    const { targetStageId, workflowId, teamLogin, scheduleStart, scheduleEnd } = parsed.data;

    try {
      // 1) Persist the schedule window FIRST. AssignIClassTeam (step 3) reads
      // scheduleStart/scheduleEnd off the PERSISTED task (task.startDate/endDate),
      // not from a parameter — so the window must already be there before the OS
      // is even created.
      const scheduled = await updateTask.execute(taskId, {
        startDate: scheduleStart.toISOString(),
        endDate: scheduleEnd.toISOString(),
      });
      if (!scheduled) {
        res.status(404).json({ error: 'Task not found', code: 'TASK_NOT_FOUND' });
        return;
      }

      // 2) Create the Service Order in IClass (idempotent — SendTaskToIClass
      // itself handles "already has iclassOrderCode" and "feature flag off").
      await sendTaskToIClass.execute(taskId, targetStageId, workflowId);

      // 3) Assign technician + the schedule window just persisted to the
      // freshly created OS. No rollback/compensation on failure here by design:
      // the OS already exists in IClass and task.iclassOrderCode is already
      // persisted — that is valid, useful state even if this step fails.
      const assigned = await assignIClassTeam.execute({ taskId, teamLogin, actorId: null });
      res.status(200).json(assigned);
    } catch (err) {
      // From updateTask: ReferenceNotFoundError is NOT a DomainError (same caveat
      // as POST / above) — but it can only fire for FK fields, and this call only
      // ever sends startDate/endDate, so it never applies here in practice; kept
      // out of this catch on purpose (no dead branch).
      //
      // From sendTaskToIClass: TaskNotFoundError, MissingProjectForIClassError,
      // MissingIClassMappingError, MissingRequiredFieldsError, IClassNodeNotFoundError,
      // IClassRejectedError, IClassUnavailableError, StageNotFoundError.
      //
      // From assignIClassTeam: IClassActionDisabledError, IClassNoServiceOrderError,
      // IClassTaskNotOpenError, IClassTeamNotAssignableError, IClassAlreadyClosedError,
      // MissingRequiredFieldsError.
      //
      // All of the above ARE DomainErrors already mapped by the global errorHandler
      // — no explicit instanceof catches needed here.
      next(err);
    }
  });

  return router;
}
