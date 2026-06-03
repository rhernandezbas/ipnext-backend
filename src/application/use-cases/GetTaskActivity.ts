import { TaskNotFoundError, InvalidCursorError } from '@domain/errors/scheduling';
import type { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import type {
  TaskActivityRepository,
  TaskActivityCursor,
} from '@domain/ports/TaskActivityRepository';
import type { TaskActivity } from '@domain/entities/taskActivity';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Clamp a requested page size to 1..200, defaulting to 50 when absent/NaN. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

/** Opaque keyset cursor: base64url("<ISO createdAt>|<id>"). */
export function encodeCursor(cursor: TaskActivityCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`).toString('base64url');
}

/** Decode a cursor, validating shape + ISO date. Throws InvalidCursorError on any malformed input. */
export function decodeCursor(raw: string): TaskActivityCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError();
  }
  const sep = decoded.indexOf('|');
  // Need a separator that is neither first nor last char (both parts non-empty).
  if (sep <= 0 || sep === decoded.length - 1) throw new InvalidCursorError();
  const createdAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!id || Number.isNaN(Date.parse(createdAt))) throw new InvalidCursorError();
  return { createdAt, id };
}

export interface GetTaskActivityOptions {
  limit?: number;
  cursor?: string;
}

export interface TaskActivityPage {
  items: TaskActivity[];
  nextCursor: string | null;
}

/**
 * Read side of the task activity feed (#10 / REQ-READ-1).
 *
 * Validates the task exists (404), clamps the page size, decodes the inbound
 * cursor (400 on malformed), and fetches `limit + 1` rows to derive `nextCursor`
 * (the +1 lives here, not in the repository — keeps the repo's `limit` honest).
 */
export class GetTaskActivity {
  constructor(
    private readonly scheduling: SchedulingRepository,
    private readonly activities: TaskActivityRepository,
  ) {}

  async execute(taskId: string, opts: GetTaskActivityOptions): Promise<TaskActivityPage> {
    const task = await this.scheduling.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    const limit = clampLimit(opts.limit);
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : undefined;

    const rows = await this.activities.listByTask({ taskId, limit: limit + 1, cursor });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

    return { items, nextCursor };
  }
}
