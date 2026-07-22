/**
 * bulk-task-recipients (D2, TASK-3) — port for the resolution side of the "Tarea"
 * bulk-recipient domain: clients with >=1 OPEN task in a mapped Stage. SEPARATE from
 * `TaskStageRecipientConfigRepository` (config-CRUD) and from `CustomerRepository`/
 * `ManualRecipientSource` (disciplina D-pattern — a narrow port per capability, never
 * bolted onto an existing one).
 */
export interface TaskRecipientSource {
  /**
   * DISTINCT `clientId` of `ScheduledTask` rows with `stageId IN (stageIds)`,
   * `generalStatus = 'open'` (fix wave F1 — NEVER the legacy `isClosed` flag: a
   * `dismissed` task has `isClosed === false` too), `customerId != null`. Network
   * tasks (`customerId` null) are EXCLUDED here — they are not a config error, just
   * not resolvable to a client.
   */
  listClientIdsByOpenTaskStages(stageIds: string[]): Promise<string[]>;
  /**
   * Count of OPEN tasks in the given stages with NO client (`customerId = null`) —
   * the honest "N tareas de red sin cliente" chip, never a silent drop.
   */
  countOpenTasksWithoutCustomer(stageIds: string[]): Promise<number>;
}
