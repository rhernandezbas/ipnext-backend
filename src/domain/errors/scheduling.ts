import { DomainError } from './index';

export type ReferenceKind = 'customer' | 'contract' | 'partner' | 'project' | 'reporter' | 'assignee' | 'watcher' | 'ticket';

export class ReferenceNotFoundError extends Error {
  constructor(public readonly kind: ReferenceKind, public readonly id: string) {
    super(`${kind} not found: ${id}`);
    this.name = 'ReferenceNotFoundError';
  }
}

export class TaskNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Task with id ${id} not found`, 'TASK_NOT_FOUND');
    this.name = 'TaskNotFoundError';
  }
}

/** Raised when required fields are missing before sending a task to IClass. Carries the missing field names for the front-end modal. */
export class MissingRequiredFieldsError extends DomainError {
  constructor(public readonly missingFields: string[]) {
    super(`Missing required fields: ${missingFields.join(', ')}`, 'MISSING_REQUIRED_FIELDS');
    this.name = 'MissingRequiredFieldsError';
  }
}

export class StageNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Stage with id ${id} not found`, 'STAGE_NOT_FOUND');
    this.name = 'StageNotFoundError';
  }
}

export class WorkflowNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Workflow with id ${id} not found`, 'WORKFLOW_NOT_FOUND');
    this.name = 'WorkflowNotFoundError';
  }
}

export class StageInUseError extends DomainError {
  constructor(
    public readonly taskCount: number,
    stageId: string,
  ) {
    super(`Stage ${stageId} is in use by ${taskCount} task(s)`, 'STAGE_IN_USE');
    this.name = 'StageInUseError';
  }
}

export class WorkflowInUseError extends DomainError {
  constructor(public readonly taskCount: number) {
    super(`Workflow is in use by ${taskCount} task(s)`, 'WORKFLOW_IN_USE');
    this.name = 'WorkflowInUseError';
  }
}

export class DefaultWorkflowProtectedError extends DomainError {
  constructor() {
    super('The Default workflow cannot be deleted', 'DEFAULT_WORKFLOW_PROTECTED');
    this.name = 'DefaultWorkflowProtectedError';
  }
}

export class ReorderSetMismatchError extends DomainError {
  constructor() {
    super('The provided stage IDs do not match the workflow\'s current stages', 'REORDER_SET_MISMATCH');
    this.name = 'ReorderSetMismatchError';
  }
}

export class WorkflowNameConflictError extends DomainError {
  constructor(name: string) {
    super(`A workflow named "${name}" already exists`, 'WORKFLOW_NAME_CONFLICT');
    this.name = 'WorkflowNameConflictError';
  }
}

export class StageNameConflictError extends DomainError {
  constructor(name: string) {
    super(`A stage named "${name}" already exists in this workflow`, 'STAGE_NAME_CONFLICT');
    this.name = 'StageNameConflictError';
  }
}

export class ProjectCategoryNotFoundError extends DomainError {
  constructor(id: string) {
    super(`ProjectCategory with id ${id} not found`, 'PROJECT_CATEGORY_NOT_FOUND');
    this.name = 'ProjectCategoryNotFoundError';
  }
}

export class ProjectCategoryNameConflictError extends DomainError {
  constructor(name: string) {
    super(`A project category named "${name}" already exists`, 'PROJECT_CATEGORY_NAME_CONFLICT');
    this.name = 'ProjectCategoryNameConflictError';
  }
}

export class ProjectCategoryInUseError extends DomainError {
  constructor(public readonly projectCount: number) {
    super(`ProjectCategory is in use by ${projectCount} project(s)`, 'PROJECT_CATEGORY_IN_USE');
    this.name = 'ProjectCategoryInUseError';
  }
}

export class TaskCategoryNotFoundError extends DomainError {
  constructor(id: string) {
    super(`TaskCategory with id ${id} not found`, 'TASK_CATEGORY_NOT_FOUND');
    this.name = 'TaskCategoryNotFoundError';
  }
}

export class TaskCategoryNameConflictError extends DomainError {
  constructor(name: string) {
    super(`A task category named "${name}" already exists`, 'TASK_CATEGORY_NAME_CONFLICT');
    this.name = 'TaskCategoryNameConflictError';
  }
}

export class TaskCategoryInUseError extends DomainError {
  constructor(public readonly taskCount: number) {
    super(`TaskCategory is in use by ${taskCount} task(s)`, 'TASK_CATEGORY_IN_USE');
    this.name = 'TaskCategoryInUseError';
  }
}

export class TaskPriorityNotFoundError extends DomainError {
  constructor(id: string) {
    super(`TaskPriority with id ${id} not found`, 'TASK_PRIORITY_NOT_FOUND');
    this.name = 'TaskPriorityNotFoundError';
  }
}

export class TaskPriorityNameConflictError extends DomainError {
  constructor(name: string) {
    super(`A task priority named "${name}" already exists`, 'TASK_PRIORITY_NAME_CONFLICT');
    this.name = 'TaskPriorityNameConflictError';
  }
}

export class TaskPriorityInUseError extends DomainError {
  constructor(public readonly taskCount: number) {
    super(`TaskPriority is in use by ${taskCount} task(s)`, 'TASK_PRIORITY_IN_USE');
    this.name = 'TaskPriorityInUseError';
  }
}

/**
 * Raised when the GR ingest cannot resolve a required catalog entry (the task
 * priority or category NAME it must stamp on every created task does not exist
 * as a row in the corresponding catalog).
 *
 * This is BLOCKING by design: rather than write a phantom priority/category that
 * exists in no catalog (the prod bug), the ingest aborts the whole run and
 * creates ZERO tasks until the catalog is fixed.
 */
export class IngestCatalogEntryMissingError extends DomainError {
  constructor(
    public readonly catalog: 'priority' | 'category',
    public readonly name: string,
  ) {
    super(
      `GR ingest aborted: required ${catalog} "${name}" not found in its catalog. ` +
        'No tasks were created. Add the entry to the catalog and re-run.',
      'INGEST_CATALOG_ENTRY_MISSING',
    );
    this.name = 'IngestCatalogEntryMissingError';
  }
}

export class ProjectTypeNotFoundError extends DomainError {
  constructor(id: string) {
    super(`ProjectType with id ${id} not found`, 'PROJECT_TYPE_NOT_FOUND');
    this.name = 'ProjectTypeNotFoundError';
  }
}

export class ProjectTypeNameConflictError extends DomainError {
  constructor(name: string) {
    super(`A project type named "${name}" already exists`, 'PROJECT_TYPE_NAME_CONFLICT');
    this.name = 'ProjectTypeNameConflictError';
  }
}

export class ProjectTypeInUseError extends DomainError {
  constructor(public readonly projectCount: number) {
    super(`ProjectType is in use by ${projectCount} project(s)`, 'PROJECT_TYPE_IN_USE');
    this.name = 'ProjectTypeInUseError';
  }
}
