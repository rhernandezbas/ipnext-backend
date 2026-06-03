/**
 * TaskActivityRecorder — write-only domain port consumed by every write use case.
 *
 * Distinct from `TaskActivityRepository` on purpose: write UCs only need to emit
 * events wrapped with the actor, and the recording must be BEST-EFFORT — a
 * failure to record activity must NEVER abort the originating operation
 * (REQ-RESILIENCE-1). The recorder implementation owns that try/catch contract;
 * the repository keeps a clean CRUD shape for the read side.
 */
import type { ActivityType } from '../entities/taskActivity';

/** The user (or system) responsible for an action. Null actorId = system/automatic. */
export interface ActorContext {
  actorId: string | null;
  actorName: string;
}

export interface TaskActivityRecorder {
  record(
    taskId: string,
    type: ActivityType,
    payload: {
      actor: ActorContext;
      fromValue?: unknown;
      toValue?: unknown;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<void>;

  recordMany(
    taskId: string,
    events: Array<{
      type: ActivityType;
      actor: ActorContext;
      fromValue?: unknown;
      toValue?: unknown;
      metadata?: Record<string, unknown> | null;
    }>,
  ): Promise<void>;
}
