import { DomainError } from './index';

export type ReferenceKind = 'customer' | 'contract' | 'partner' | 'project' | 'reporter' | 'assignee' | 'watcher' | 'ticket' | 'networkSite' | 'user';

export class ReferenceNotFoundError extends Error {
  constructor(public readonly kind: ReferenceKind, public readonly id: string) {
    super(`${kind} not found: ${id}`);
    this.name = 'ReferenceNotFoundError';
  }
}

/**
 * #40 — Raised when a task's kind does not match the kind of the project it is
 * being attached to (network task → non-network project, or vice versa).
 *
 * Domain code is PROJECT_KIND_MISMATCH; the HTTP layer maps it to 422 with the
 * wire code INVALID_PROJECT_KIND (frozen Wire Contract).
 */
export class ProjectKindMismatchError extends DomainError {
  constructor(
    public readonly projectId: string,
    public readonly taskKind: 'customer' | 'network',
  ) {
    super(
      `Project ${projectId} kind does not match task kind '${taskKind}'`,
      'PROJECT_KIND_MISMATCH',
    );
    this.name = 'ProjectKindMismatchError';
  }
}

export class TaskNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Task with id ${id} not found`, 'TASK_NOT_FOUND');
    this.name = 'TaskNotFoundError';
  }
}

/**
 * #86 — Raised by ArchiveTask when the task's generalStatus is 'open'.
 * Only closed or dismissed tasks can be archived. Mapped to 422 TASK_NOT_CLOSED.
 */
export class TaskNotClosedError extends DomainError {
  constructor(id: string) {
    super(`Task ${id} must be closed or dismissed before archiving`, 'TASK_NOT_CLOSED');
    this.name = 'TaskNotClosedError';
  }
}

/**
 * #41 — Raised by SetTaskGeneralStatus when an unknown general-status value is
 * supplied (defensive validation in the use case; the zod body guard already
 * rejects bad values at the HTTP edge with 400). Mapped to 422 at the route.
 */
export class InvalidGeneralStatusError extends DomainError {
  constructor(public readonly value: string) {
    super(`Invalid general status: ${value}`, 'INVALID_GENERAL_STATUS');
    this.name = 'InvalidGeneralStatusError';
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

/** Raised when a task-activity pagination cursor is malformed (bad base64 / shape / date). */
export class InvalidCursorError extends DomainError {
  constructor() {
    super('The provided activity cursor is malformed', 'INVALID_CURSOR');
    this.name = 'InvalidCursorError';
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

/**
 * #53 — Raised when a network task is created or updated with a blank address.
 * Domain code: NETWORK_TASK_ADDRESS_REQUIRED; HTTP layer maps it to 422.
 */
export class NetworkTaskAddressRequiredError extends DomainError {
  constructor() {
    super('Network tasks require a non-blank address', 'NETWORK_TASK_ADDRESS_REQUIRED');
    this.name = 'NetworkTaskAddressRequiredError';
  }
}

/**
 * #54 — Raised when a network task is created or updated with a blank iclassCityCode.
 * Domain code: NETWORK_TASK_LOCALITY_REQUIRED; HTTP layer maps it to 422.
 * #66 — Now only thrown for fibra tasks; red tasks do NOT require locality.
 */
export class NetworkTaskLocalityRequiredError extends DomainError {
  constructor() {
    super('Network tasks require a non-blank iclassCityCode (locality)', 'NETWORK_TASK_LOCALITY_REQUIRED');
    this.name = 'NetworkTaskLocalityRequiredError';
  }
}

/**
 * #66 — Raised when a fibra network task is created or updated with a blank networkSiteName.
 * Domain code: NETWORK_TASK_NODE_NAME_REQUIRED; HTTP layer maps it to 422.
 */
export class NetworkTaskNodeNameRequiredError extends DomainError {
  constructor() {
    super('Fibra network tasks require a non-blank networkSiteName (node name)', 'NETWORK_TASK_NODE_NAME_REQUIRED');
    this.name = 'NetworkTaskNodeNameRequiredError';
  }
}

/**
 * #66 — Raised when a fibra network task carries a networkSiteId FK (the hybrid
 * fibra+site shape). Fibra tasks use a free-text node name, never a site FK; the
 * JOIN would otherwise win over the free-text name (and a non-existent siteId would
 * blow up as a Prisma 500). Rejected at both DTO superRefine and CreateTask (two
 * layers of the seam). Domain code: FIBRA_TASK_NO_SITE; HTTP layer maps it to 422.
 */
export class FibraTaskNoSiteError extends DomainError {
  constructor() {
    super('Fibra network tasks must not carry a networkSiteId (use a free-text node name)', 'FIBRA_TASK_NO_SITE');
    this.name = 'FibraTaskNoSiteError';
  }
}

/**
 * #66 — Raised when an UpdateTask attempts to change networkType after create.
 * networkType is an IDENTITY discriminator (red vs fibra), not a mutable state:
 * a task created with the wrong type must be recreated, not switched. Switching
 * would leave a dangling FK (red→fibra) or accept-and-ignore a site change
 * (fibra→red). Domain code: NETWORK_TYPE_IMMUTABLE; HTTP layer maps it to 422.
 */
export class NetworkTypeImmutableError extends DomainError {
  constructor() {
    super('networkType is immutable after creation; create a new task instead', 'NETWORK_TYPE_IMMUTABLE');
    this.name = 'NetworkTypeImmutableError';
  }
}
