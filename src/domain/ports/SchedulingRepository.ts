import { ScheduledTask, TaskGeneralStatus } from '../entities/scheduling';
import { Stage } from '../entities/workflow';
import { TaskChecklistItem } from '../entities/checklist';
import { TaskListFilter } from '@application/dto/scheduling.dto';

export interface CreateTaskInput extends Omit<ScheduledTask,
  'id' | 'sequenceNumber' | 'stageCategory' | 'customerName' | 'customerCity' | 'customerPhone' | 'customerCode' | 'contractCode' | 'assigneeName' | 'reporterName' | 'watcherIds' | 'createdAt' | 'updatedAt' | 'generalStatus' | 'isClosed' | 'reviewedByInventory' | 'reviewedByInventoryAt' | 'reviewedByInventoryUserName' | 'closureCommentDone' | 'closureAuditDone' | 'closureHasDeviceInventory' | 'iclassOrderCode' | 'grOrdenId' | 'ticketSubject' | 'ticketId' | 'networkSiteName' | 'kind' | 'networkSiteId' | 'iclassCityCode' | 'networkType' | 'archivedAt' | 'iclassStatusCode' | 'iclassStatusUpdatedAt' | 'iclassStatus' | 'onuSerial'
> {
  /** Discriminador de tipo de tarea. Por defecto 'customer' para retro-compatibilidad. */
  kind?: 'customer' | 'network';
  /**
   * #66 — Red/FO switch. 'red' = FK to NetworkSite; 'fibra' = free-text node name.
   * Defaults to 'red' when kind='network' and not provided.
   */
  networkType?: 'red' | 'fibra' | null;
  /** FK al NetworkSite. Solo aplica cuando kind='network' y networkType='red'. */
  networkSiteId?: string | null;
  /**
   * #66 — Free-text node name for fibra tasks (networkSiteId must be null).
   * For red tasks, networkSiteName is JOIN-derived from NetworkSite.name (input ignored).
   */
  networkSiteName?: string | null;
  watcherIds?: string[];
  /** GR ingest sets this; manual task creation omits it (defaults to null). */
  grOrdenId?: string | null;
  /** Optional ticket FK — validated against ticketLookup when non-null. */
  ticketId?: string | null;
  /**
   * #54 — task-level locality snapshot. Required (non-blank) for fibra tasks;
   * optional for red tasks and customer tasks. Guard fires in CreateTask/UpdateTask use cases.
   * Omitted from the base Omit so it's explicitly typed as optional here.
   */
  iclassCityCode?: string | null;
}

export interface UpdateTaskInput extends Partial<CreateTaskInput> {
  isClosed?: boolean;
  // #41 — lifecycle state. When present, wins over isClosed (precedence D4).
  generalStatus?: TaskGeneralStatus;
  reviewedByInventory?: boolean;
  /**
   * K3 (fiber-auto-watcher) — serial de la ONU de la instalación. El use case
   * lo normaliza SIEMPRE (UPPERCASE sin espacios) antes de persistir; null limpia.
   */
  onuSerial?: string | null;
}

/**
 * Flat projection used by SendTaskToIClass to resolve the task's project
 * and its assigned IClass SO type in a single query (AD-4).
 */
export interface TaskProjectMapping {
  projectId: string;
  projectTitle: string;
  iclassSoType: { id: string; code: string; active: boolean } | null;
}

export interface SchedulingRepository {
  listTasks(filter?: TaskListFilter): Promise<ScheduledTask[]>;
  getTask(id: string): Promise<ScheduledTask | null>;
  createTask(data: CreateTaskInput): Promise<ScheduledTask>;
  updateTask(id: string, data: UpdateTaskInput): Promise<ScheduledTask | null>;
  /**
   * #14: mark closure-completeness flags WITHOUT going through updateTask, so the
   * activity-log diff engine does not emit events for these internal flags.
   */
  markClosureCompleteness(
    taskId: string,
    flags: Partial<Pick<ScheduledTask, 'closureCommentDone' | 'closureAuditDone' | 'closureHasDeviceInventory'>>,
  ): Promise<void>;
  deleteTask(id: string): Promise<boolean>;
  /**
   * #86 — Set archivedAt = now() on a task (idempotent: if already archived, returns the task unchanged).
   * Returns null when the task does not exist.
   */
  archiveTask(id: string): Promise<ScheduledTask | null>;
  moveTaskToStage(id: string, stageId: string): Promise<ScheduledTask | null>;
  /**
   * iclass-intermediate-states — forward-only stage move for the IClass status auto-mapping.
   *
   * Moves the task to `targetStageId` ONLY when the target stage's `order` is >= the task's
   * current stage `order` (Stage HAS an `order` column). This implements the "solo avanza"
   * policy: the cron never retreats a task to an earlier column, so an operator's manual
   * advance is respected. The order comparison lives here (the adapter owns Stage data).
   *
   * Returns `{ moved: true }` when it moved, `{ moved: false }` when it was a no-op
   * (task/stage missing, same stage, or target order < current order). Best-effort by
   * contract: the caller swallows failures so a bad move never breaks the status capture.
   */
  moveTaskToStageIfForward(taskId: string, targetStageId: string): Promise<{ moved: boolean }>;

  // RV — Revisado por Inventario (change 6, F3 traceability)
  setInventoryReview(taskId: string, reviewed: boolean, actorId: string | null): Promise<ScheduledTask | null>;

  // Gestión Real installation-order ingest (gestion-real-installation-ingest)
  /** Find a task previously ingested from the given GR order id. Null when none. */
  findTaskByGrOrdenId(grOrdenId: string): Promise<ScheduledTask | null>;
  /** Tasks awaiting manual review: ingested but unclassified (projectId = null). */
  listNeedsReview(): Promise<ScheduledTask[]>;

  // IClass integration (task-send-to-iclass)
  /**
   * @deprecated Use getStageByCode. Stages are identified by `code` (immutable),
   * not by `name` (editable by the user). Kept for one cycle for compat.
   */
  getStageByName(name: string, workflowId?: string): Promise<Stage | null>;
  /**
   * Resolve a Stage by its immutable business `code`, scoped to the workflow.
   * The (workflowId, code) pair is unique per @@unique([workflowId, code]).
   */
  getStageByCode(code: string, workflowId: string): Promise<Stage | null>;
  /**
   * Returns the workflow's first stage — the one with the lowest `order` — i.e.
   * the entry state a newly-created task should land in. Null when the workflow
   * has no stages (or does not exist). Used by the GR ingest to resolve the
   * initial stage from the project's workflow instead of a hardcoded stage name.
   */
  getInitialStage(workflowId: string): Promise<Stage | null>;
  /** Persist the IClass service order code on a task after a successful OS creation. */
  setIClassOrderCode(taskId: string, code: string): Promise<ScheduledTask | null>;

  // IClass closure loop (iclass-closure-loop)
  /**
   * Find a task by its sequenceNumber — the join key for the closure loop, since
   * we send soCode = sequenceNumber and IClass preserves it as the SO `codigo`.
   * Null when no task has that number.
   */
  findTaskBySequenceNumber(sequenceNumber: number): Promise<ScheduledTask | null>;
  /**
   * List tasks already sent to IClass and awaiting closure (in the in-flight stage),
   * resolved by stage `code` (rename-safe).
   */
  listTasksInIClassStage(stageCode: string): Promise<ScheduledTask[]>;
  /**
   * Closure reconcile: move the task to `mappedStageId` ONLY IF it is still parked
   * in the in-flight stage (resolved by `inFlightStageCode`) — i.e. it was mirrored
   * but never transitioned because its result-code→stage mapping was missing/failed
   * at first mirror and was fixed later. Returns true when it moved, false when the
   * task already left the in-flight stage (so a reconcile never overrides a manual
   * placement). Fires no closure side-effects.
   */
  reconcileStuckTaskStage(taskId: string, mappedStageId: string, inFlightStageCode: string): Promise<boolean>;

  // IClass SO type mapping (iclass-so-type-mapping)
  /**
   * Returns a flat projection of the task's project + its assigned IClass SO type.
   * Returns null if the task does not exist OR if the task has no projectId (AD-4).
   */
  getTaskProjectMapping(taskId: string): Promise<TaskProjectMapping | null>;

  // IClass status tracking (iclass-status-sync)
  /**
   * Write the IClass status code on a task (conditional — only persists when the
   * code actually changed, so repeated ticks are idempotent). Also sets iclassStatusUpdatedAt.
   * No-op (does NOT throw) when the taskId does not exist — graceful degradation.
   */
  setIClassStatus(taskId: string, statusCode: string, at: Date): Promise<void>;

  // Checklist methods (change 5)
  getTaskWithChecklist(id: string): Promise<(ScheduledTask & { checklist: TaskChecklistItem[] }) | null>;
  addChecklistItem(taskId: string, text: string): Promise<TaskChecklistItem>;
  toggleChecklistItem(itemId: string): Promise<TaskChecklistItem>;
  updateChecklistItem(itemId: string, text: string): Promise<TaskChecklistItem>;
  removeChecklistItem(itemId: string): Promise<boolean>;
  reorderChecklistItems(taskId: string, orderedIds: string[]): Promise<TaskChecklistItem[]>;
  assignTemplateToTask(taskId: string, templateId: string): Promise<TaskChecklistItem[]>;
  clearChecklist(taskId: string): Promise<void>;
}
