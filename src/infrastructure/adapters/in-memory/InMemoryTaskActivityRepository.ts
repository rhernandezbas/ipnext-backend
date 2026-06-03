import { randomUUID } from 'crypto';
import type { TaskActivity } from '@domain/entities/taskActivity';
import type {
  CreateTaskActivityInput,
  ListTaskActivityFilter,
  TaskActivityRepository,
} from '@domain/ports/TaskActivityRepository';

/**
 * InMemoryTaskActivityRepository — test seam for TaskActivityRepository.
 *
 * Array-backed, mirrors the Prisma adapter's keyset semantics: newest-first
 * `(createdAt DESC, id DESC)` ordering and a cursor that returns only rows
 * STRICTLY older than the cursor. `now` is injectable for deterministic tests.
 */
export class InMemoryTaskActivityRepository implements TaskActivityRepository {
  private readonly store: TaskActivity[] = [];
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  async create(input: CreateTaskActivityInput): Promise<TaskActivity> {
    const activity: TaskActivity = {
      id: randomUUID(),
      taskId: input.taskId,
      type: input.type,
      actorId: input.actorId,
      actorName: input.actorName,
      fromValue: input.fromValue ?? null,
      toValue: input.toValue ?? null,
      metadata: input.metadata ?? null,
      createdAt: this.now().toISOString(),
    };
    this.store.push(activity);
    return { ...activity };
  }

  async createMany(inputs: CreateTaskActivityInput[]): Promise<number> {
    for (const input of inputs) {
      await this.create(input);
    }
    return inputs.length;
  }

  async listByTask(filter: ListTaskActivityFilter): Promise<TaskActivity[]> {
    const rows = this.store
      .filter(a => a.taskId === filter.taskId)
      .sort(compareDesc);

    const afterCursor = filter.cursor
      ? rows.filter(a => isStrictlyOlder(a, filter.cursor!))
      : rows;

    return afterCursor.slice(0, filter.limit).map(a => ({ ...a }));
  }
}

/** Sort newest-first: createdAt DESC, then id DESC as a stable tie-break. */
function compareDesc(a: TaskActivity, b: TaskActivity): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** True when `a` sorts strictly after the cursor in the newest-first order. */
function isStrictlyOlder(a: TaskActivity, cursor: { createdAt: string; id: string }): boolean {
  if (a.createdAt !== cursor.createdAt) return a.createdAt < cursor.createdAt;
  return a.id < cursor.id;
}
