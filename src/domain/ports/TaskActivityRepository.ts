/**
 * TaskActivityRepository — domain port for the task activity feed.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 * The read use case (`GetTaskActivity`) and the recorder implementation depend
 * on this interface; the concrete Prisma/InMemory adapters implement it.
 */
import type { ActivityType, TaskActivity } from '../entities/taskActivity';

/** Keyset-pagination cursor — points at the last item of the previous page. */
export interface TaskActivityCursor {
  createdAt: string;
  id: string;
}

export interface ListTaskActivityFilter {
  taskId: string;
  /** 1..200, clamped by the use case before reaching the repository. */
  limit: number;
  /** When present, returns only rows strictly OLDER than this cursor. */
  cursor?: TaskActivityCursor;
}

export interface CreateTaskActivityInput {
  taskId: string;
  type: ActivityType;
  actorId: string | null;
  actorName: string;
  fromValue?: unknown;
  toValue?: unknown;
  metadata?: Record<string, unknown> | null;
}

export interface TaskActivityRepository {
  create(input: CreateTaskActivityInput): Promise<TaskActivity>;
  /** Batch insert (e.g. UpdateTask diff emitting N events). Returns inserted count. */
  createMany(inputs: CreateTaskActivityInput[]): Promise<number>;
  /**
   * Newest-first feed for one task. Ordered by `(createdAt DESC, id DESC)`.
   * Returns at most `filter.limit` rows; the use case fetches limit+1 to derive
   * the next cursor.
   */
  listByTask(filter: ListTaskActivityFilter): Promise<TaskActivity[]>;
}
