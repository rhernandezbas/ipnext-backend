import { TaskRecipientSource } from '@domain/ports/TaskRecipientSource';

/** Fixture shape for a `ScheduledTask` row (test-only, mirrors `stageId`/`isClosed`/`customerId`). */
export interface TaskFixture {
  clientId: string | null;
  stageId: string;
  isClosed: boolean;
}

/**
 * bulk-task-recipients (B2.4, D2) — in-memory mirror of the resolution port. Fixture
 * array of tasks `{clientId, stageId, isClosed}` (a `clientId:null` row mirrors a
 * network task). Mirrors the Prisma adapter's predicate exactly: `stageId IN (...)`,
 * `isClosed = false`, and splits on `customerId` null/not-null the same way
 * `findMany`/`count` would in Postgres.
 */
export class InMemoryTaskRecipientSource implements TaskRecipientSource {
  constructor(private readonly tasks: TaskFixture[] = []) {}

  async listClientIdsByOpenTaskStages(stageIds: string[]): Promise<string[]> {
    const distinct = new Set<string>();
    for (const task of this.tasks) {
      if (!stageIds.includes(task.stageId)) continue;
      if (task.isClosed) continue;
      if (task.clientId === null) continue;
      distinct.add(task.clientId);
    }
    return Array.from(distinct);
  }

  async countOpenTasksWithoutCustomer(stageIds: string[]): Promise<number> {
    return this.tasks.filter(
      (task) => stageIds.includes(task.stageId) && !task.isClosed && task.clientId === null,
    ).length;
  }
}
