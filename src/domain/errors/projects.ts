import { DomainError } from './index';

export type ReferenceKind = 'category' | 'type' | 'workflow' | 'lead' | 'partner';

export class ReferenceNotFoundError extends Error {
  constructor(public readonly reference: ReferenceKind, public readonly id: string) {
    super(`${reference} not found: ${id}`);
    this.name = 'ReferenceNotFoundError';
  }
}

/**
 * Raised when an operation cannot proceed because the project still has tasks
 * in active stage categories ("nuevo" or "enProgreso"). Used by the soft-delete
 * flow to block disabling a project whose active work is not yet finished.
 */
export class ProjectHasActiveTasksError extends DomainError {
  constructor(
    public readonly projectId: string,
    public readonly activeCounts: { nuevo: number; enProgreso: number },
  ) {
    super(
      `Project ${projectId} has active tasks (nuevo: ${activeCounts.nuevo}, enProgreso: ${activeCounts.enProgreso})`,
      'PROJECT_HAS_ACTIVE_TASKS',
    );
    this.name = 'ProjectHasActiveTasksError';
  }
}
