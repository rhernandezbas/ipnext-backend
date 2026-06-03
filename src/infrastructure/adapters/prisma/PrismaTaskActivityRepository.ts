import { Prisma } from '@prisma/client';
import { prisma } from '@infrastructure/database/prisma';
import type { ActivityType, TaskActivity } from '@domain/entities/taskActivity';
import type {
  CreateTaskActivityInput,
  ListTaskActivityFilter,
  TaskActivityRepository,
} from '@domain/ports/TaskActivityRepository';

/** Shape of the persisted row this adapter maps from (decoupled from Prisma's generated type). */
interface TaskActivityRow {
  id: string;
  taskId: string;
  type: string;
  actorId: string | null;
  actorName: string;
  fromValue: unknown;
  toValue: unknown;
  metadata: unknown;
  createdAt: Date;
}

/** Pure row→entity mapper. Exported for unit testing (no DB needed). */
export function toTaskActivity(row: TaskActivityRow): TaskActivity {
  return {
    id: row.id,
    taskId: row.taskId,
    type: row.type as ActivityType,
    actorId: row.actorId,
    actorName: row.actorName,
    fromValue: row.fromValue ?? null,
    toValue: row.toValue ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * PrismaTaskActivityRepository — Postgres-backed activity feed.
 *
 * `listByTask` is keyset-paginated: ordered `(createdAt DESC, id DESC)` and the
 * cursor returns rows STRICTLY older than it via an OR predicate. It returns at
 * most `filter.limit` rows; the GetTaskActivity use case requests limit+1 to
 * derive `nextCursor` (the +1 lives in the use case, not here — keeps the repo's
 * `limit` honest and consistent with InMemoryTaskActivityRepository).
 */
export class PrismaTaskActivityRepository implements TaskActivityRepository {
  constructor(private readonly db = prisma) {}

  async create(input: CreateTaskActivityInput): Promise<TaskActivity> {
    const row = await this.db.scheduledTaskActivity.create({
      data: {
        taskId: input.taskId,
        type: input.type,
        actorId: input.actorId,
        actorName: input.actorName,
        fromValue: toJson(input.fromValue),
        toValue: toJson(input.toValue),
        metadata: toJson(input.metadata),
      },
    });
    return toTaskActivity(row);
  }

  async createMany(inputs: CreateTaskActivityInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    const result = await this.db.scheduledTaskActivity.createMany({
      data: inputs.map(input => ({
        taskId: input.taskId,
        type: input.type,
        actorId: input.actorId,
        actorName: input.actorName,
        fromValue: toJson(input.fromValue),
        toValue: toJson(input.toValue),
        metadata: toJson(input.metadata),
      })),
    });
    return result.count;
  }

  async listByTask(filter: ListTaskActivityFilter): Promise<TaskActivity[]> {
    const where: Record<string, unknown> = { taskId: filter.taskId };
    if (filter.cursor) {
      const at = new Date(filter.cursor.createdAt);
      where.OR = [
        { createdAt: { lt: at } },
        { createdAt: at, id: { lt: filter.cursor.id } },
      ];
    }
    const rows = await this.db.scheduledTaskActivity.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit,
    });
    return rows.map(toTaskActivity);
  }
}

/** Prisma's Json input rejects plain `null`/`undefined`; map absent values to JsonNull (SQL NULL). */
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === undefined || value === null
    ? Prisma.JsonNull
    : (value as Prisma.InputJsonValue);
}
