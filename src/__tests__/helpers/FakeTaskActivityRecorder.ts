import type { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import type { ActivityType } from '@domain/entities/taskActivity';

interface EventPayload {
  actor: ActorContext;
  fromValue?: unknown;
  toValue?: unknown;
  metadata?: Record<string, unknown> | null;
}

export interface RecordedCall {
  taskId: string;
  type: ActivityType;
  payload: EventPayload;
}

export interface RecordedManyCall {
  taskId: string;
  events: Array<{ type: ActivityType } & EventPayload>;
}

/**
 * Test double for TaskActivityRecorder — captures every emitted event so write
 * use-case tests can assert what was recorded (type, actor, from/to, metadata).
 */
export class FakeTaskActivityRecorder implements TaskActivityRecorder {
  public readonly calls: RecordedCall[] = [];
  public readonly manyCalls: RecordedManyCall[] = [];

  async record(taskId: string, type: ActivityType, payload: EventPayload): Promise<void> {
    this.calls.push({ taskId, type, payload });
  }

  async recordMany(taskId: string, events: Array<{ type: ActivityType } & EventPayload>): Promise<void> {
    this.manyCalls.push({ taskId, events });
  }

  /** Flattened list of every emitted event type (single + batched), in order. */
  get allTypes(): ActivityType[] {
    return [
      ...this.calls.map(c => c.type),
      ...this.manyCalls.flatMap(m => m.events.map(e => e.type)),
    ];
  }
}
