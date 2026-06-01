import { ScheduledTask } from '../entities/scheduling';
import { Stage } from '../entities/workflow';
import { TaskChecklistItem } from '../entities/checklist';
import { TaskListFilter } from '@application/dto/scheduling.dto';

export interface CreateTaskInput extends Omit<ScheduledTask,
  'id' | 'sequenceNumber' | 'stageCategory' | 'customerName' | 'customerCity' | 'customerPhone' | 'customerCode' | 'assigneeName' | 'reporterName' | 'watcherIds' | 'createdAt' | 'updatedAt' | 'isClosed' | 'reviewedByInventory' | 'iclassOrderCode' | 'grOrdenId'
> {
  watcherIds?: string[];
  /** GR ingest sets this; manual task creation omits it (defaults to null). */
  grOrdenId?: string | null;
}

export interface UpdateTaskInput extends Partial<CreateTaskInput> {
  isClosed?: boolean;
  reviewedByInventory?: boolean;
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
  deleteTask(id: string): Promise<boolean>;
  moveTaskToStage(id: string, stageId: string): Promise<ScheduledTask | null>;

  // RV — Revisado por Inventario (change 6)
  setInventoryReview(taskId: string, reviewed: boolean): Promise<ScheduledTask | null>;

  // Gestión Real installation-order ingest (gestion-real-installation-ingest)
  /** Find a task previously ingested from the given GR order id. Null when none. */
  findTaskByGrOrdenId(grOrdenId: string): Promise<ScheduledTask | null>;
  /** Tasks awaiting manual review: ingested but unclassified (projectId = null). */
  listNeedsReview(): Promise<ScheduledTask[]>;

  // IClass integration (task-send-to-iclass)
  /**
   * Resolve a Stage by its name (stages are identified by name, not hardcoded id).
   * When `workflowId` is provided, the lookup is scoped to that workflow so that
   * homonymous stages in different workflows do not collide.
   */
  getStageByName(name: string, workflowId?: string): Promise<Stage | null>;
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
   * List tasks already sent to IClass and awaiting closure (in the configured
   * "Registrado en IClass" stage), used by the scoped backfill reconcile.
   */
  listTasksInIClassStage(stageName: string): Promise<ScheduledTask[]>;

  // IClass SO type mapping (iclass-so-type-mapping)
  /**
   * Returns a flat projection of the task's project + its assigned IClass SO type.
   * Returns null if the task does not exist OR if the task has no projectId (AD-4).
   */
  getTaskProjectMapping(taskId: string): Promise<TaskProjectMapping | null>;

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
