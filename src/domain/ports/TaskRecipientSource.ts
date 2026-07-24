/**
 * bulk-task-recipients (D2, TASK-3) — port for the resolution side of the "Tarea"
 * bulk-recipient domain: clients with >=1 OPEN task in a mapped Stage. SEPARATE from
 * `TaskStageRecipientConfigRepository` (config-CRUD) and from `CustomerRepository`/
 * `ManualRecipientSource` (disciplina D-pattern — a narrow port per capability, never
 * bolted onto an existing one).
 */

/** bulk-task-stage-transition (D2) — una tarea abierta resuelta, con su origen para el guard still-in-A. */
export interface OpenTaskRow {
  taskId: string;
  clientId: string;
  fromStageId: string;
}

export interface TaskRecipientSource {
  /**
   * DISTINCT `clientId` of `ScheduledTask` rows with `stageId IN (stageIds)`,
   * `generalStatus = 'open'` (fix wave F1 — NEVER the legacy `isClosed` flag: a
   * `dismissed` task has `isClosed === false` too), `customerId != null`. Network
   * tasks (`customerId` null) are EXCLUDED here — they are not a config error, just
   * not resolvable to a client.
   *
   * bulk-task-stage-transition — CONSERVADO (lo usan el count agregado y compat),
   * pero la resolución de destinatarios pasa a `listOpenTasksByStages` (per-tarea).
   */
  listClientIdsByOpenTaskStages(stageIds: string[]): Promise<string[]>;
  /**
   * bulk-task-stage-transition (D2, TASK-3 MODIFIED) — UNA fila POR TAREA abierta
   * (`generalStatus = 'open'`, `customerId != null`, `stageId IN (stageIds)`), NO
   * `clientId` DISTINCT. Cada tarea es una unidad de envío independiente (decisión 2/3):
   * un cliente con 2 tareas en los stages pedidos devuelve 2 filas. `fromStageId` es el
   * stage actual de la tarea (el origen A del guard still-in-A del envío).
   */
  listOpenTasksByStages(stageIds: string[]): Promise<OpenTaskRow[]>;
  /**
   * Count of OPEN tasks in the given stages with NO client (`customerId = null`) —
   * the honest "N tareas de red sin cliente" chip, never a silent drop.
   */
  countOpenTasksWithoutCustomer(stageIds: string[]): Promise<number>;
}
