/**
 * IClassAutoAssigner — domain port.
 *
 * Abstraction for the best-effort auto-assign collaborator injected into UpdateTask (AD-2).
 * The implementation (AutoAssignIClassTeamOnTaskUpdate) lives in the application layer.
 * UpdateTask depends on THIS interface, never on the concrete use case.
 *
 * Lives in the domain layer. Zero external dependencies.
 */
import type { ActorContext } from './TaskActivityRecorder';

export type AutoAssignSkipReason =
  | 'flag-off'
  | 'no-order-code'
  /** Nadie asignado (desasignar). Distinto de `no-mapping`: no falta configuración. */
  | 'unassigned'
  /** Hay técnico asignado pero no tiene cuadrilla de IClass configurada. */
  | 'no-mapping'
  | 'team-inactive'
  | 'order-closed'
  /** The OS code exists on the task but IClass does not know it (404/204). */
  | 'order-not-found'
  | 'not-open'
  | 'no-schedule';

export type AutoAssignFailReason = 'rejected' | 'unavailable';

export interface AutoAssignOutcome {
  outcome: 'assigned' | 'skipped' | 'failed';
  reason?: AutoAssignSkipReason | AutoAssignFailReason;
  teamLogin?: string;
}

/**
 * Collaborator interface used by UpdateTask to trigger best-effort IClass team assignment.
 * maybeAssign MUST NEVER throw — all errors are captured and returned as AutoAssignOutcome.
 */
export interface IClassAutoAssigner {
  maybeAssign(
    taskId: string,
    assigneeId: string | null,
    actor?: ActorContext,
  ): Promise<AutoAssignOutcome>;
}
