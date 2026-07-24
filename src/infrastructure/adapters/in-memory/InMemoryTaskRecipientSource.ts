import { OpenTaskRow, TaskRecipientSource } from '@domain/ports/TaskRecipientSource';

/**
 * Fixture shape for a `ScheduledTask` row (test-only, mirrors `stageId`/`isClosed`/
 * `generalStatus`/`customerId`).
 *
 * fix wave (F1, HIGH) — `isClosed` is kept here because it's a REAL column of the
 * row (derived, synced on write) — but it's NEVER read by the filter below. The
 * only source of truth for "is this task open" is `generalStatus === 'open'`: a
 * `generalStatus:'dismissed'` task has `isClosed === false` too (`messaging.ts:
 * 227-228`), so a filter keyed on `isClosed` would wrongly let dismissed tasks
 * through.
 */
export interface TaskFixture {
  clientId: string | null;
  stageId: string;
  isClosed: boolean;
  generalStatus: 'open' | 'closed' | 'dismissed';
  /**
   * bulk-task-stage-transition — id de la tarea (para `listOpenTasksByStages`
   * per-tarea). OPCIONAL: los fixtures viejos que solo ejercen
   * `listClientIdsByOpenTaskStages`/`countOpenTasksWithoutCustomer` no lo necesitan;
   * cuando falta, se sintetiza uno estable por índice.
   */
  taskId?: string;
}

/**
 * bulk-task-recipients (B2.4, D2) + fix wave (F1) — in-memory mirror of the
 * resolution port. Fixture array of tasks `{clientId, stageId, isClosed,
 * generalStatus}` (a `clientId:null` row mirrors a network task). Mirrors the
 * Prisma adapter's predicate exactly: `stageId IN (...)`, `generalStatus = 'open'`
 * (NEVER `isClosed` — see `TaskFixture` doc), and splits on `customerId`
 * null/not-null the same way `findMany`/`count` would in Postgres.
 */
export class InMemoryTaskRecipientSource implements TaskRecipientSource {
  constructor(private readonly tasks: TaskFixture[] = []) {}

  async listClientIdsByOpenTaskStages(stageIds: string[]): Promise<string[]> {
    const distinct = new Set<string>();
    for (const task of this.tasks) {
      if (!stageIds.includes(task.stageId)) continue;
      if (task.generalStatus !== 'open') continue;
      if (task.clientId === null) continue;
      distinct.add(task.clientId);
    }
    return Array.from(distinct);
  }

  async listOpenTasksByStages(stageIds: string[]): Promise<OpenTaskRow[]> {
    const rows: OpenTaskRow[] = [];
    this.tasks.forEach((task, index) => {
      if (!stageIds.includes(task.stageId)) return;
      if (task.generalStatus !== 'open') return;
      if (task.clientId === null) return;
      rows.push({
        taskId: task.taskId ?? `task-${index}`,
        clientId: task.clientId,
        fromStageId: task.stageId,
      });
    });
    return rows;
  }

  async countOpenTasksWithoutCustomer(stageIds: string[]): Promise<number> {
    return this.tasks.filter(
      (task) => stageIds.includes(task.stageId) && task.generalStatus === 'open' && task.clientId === null,
    ).length;
  }
}
