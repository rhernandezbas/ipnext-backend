import type { ActivityType } from '@domain/entities/taskActivity';
import type { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import type { CreateTaskActivityInput } from '@domain/ports/TaskActivityRepository';
import { RecordTaskActivity } from '@application/use-cases/RecordTaskActivity';

/**
 * DefaultTaskActivityRecorder — best-effort recorder consumed by write use cases.
 *
 * Delegates to `RecordTaskActivity` and wraps every call in try/catch: a failure
 * to record activity is logged (warn) and SWALLOWED — it must never abort the
 * originating operation (REQ-RESILIENCE-1). The audit feed is non-critical; a
 * task update must still succeed even if its activity row fails to persist.
 */
export class DefaultTaskActivityRecorder implements TaskActivityRecorder {
  constructor(private readonly recordUseCase: RecordTaskActivity) {}

  async record(
    taskId: string,
    type: ActivityType,
    payload: {
      actor: ActorContext;
      fromValue?: unknown;
      toValue?: unknown;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    try {
      await this.recordUseCase.execute(toInput(taskId, type, payload.actor, payload));
    } catch (err) {
      warn(taskId, type, err);
    }
  }

  async recordMany(
    taskId: string,
    events: Array<{
      type: ActivityType;
      actor: ActorContext;
      fromValue?: unknown;
      toValue?: unknown;
      metadata?: Record<string, unknown> | null;
    }>,
  ): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.recordUseCase.executeMany(
        events.map(e => toInput(taskId, e.type, e.actor, e)),
      );
    } catch (err) {
      warn(taskId, events.map(e => e.type).join(',') || 'batch', err);
    }
  }
}

function toInput(
  taskId: string,
  type: ActivityType,
  actor: ActorContext,
  payload: { fromValue?: unknown; toValue?: unknown; metadata?: Record<string, unknown> | null },
): CreateTaskActivityInput {
  return {
    taskId,
    type,
    actorId: actor.actorId,
    actorName: actor.actorName,
    fromValue: payload.fromValue,
    toValue: payload.toValue,
    metadata: payload.metadata ?? null,
  };
}

function warn(taskId: string, type: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[task-activity] failed to record "${type}" for task ${taskId}:`, err);
}
