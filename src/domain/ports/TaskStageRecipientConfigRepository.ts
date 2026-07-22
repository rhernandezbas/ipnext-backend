/**
 * bulk-task-recipients (D2, TSC-2) — port for the config-CRUD side of the "Tarea"
 * bulk-recipient domain: WHICH Stages are eligible as a recipient criterion. Molde:
 * `NocBroadcastConfigRepository`, but the underlying data is a SET (N rows, one per
 * mapped stage), not a singleton.
 */

/** Hydrated view of a mapped Stage — everything the settings card + composer tab need. */
export interface MappedStage {
  stageId: string;
  stageName: string;
  stageCode: string;
  color: string | null;
  workflowId: string;
  workflowName: string;
}

/**
 * Port for reading/replacing the set of Stages eligible as bulk-recipient criteria.
 * The application layer depends on this; Prisma/InMemory adapters implement it.
 */
export interface TaskStageRecipientConfigRepository {
  /** Bare set of mapped stageIds — cheap eligibility check (`assertTaskStagesEligible`). */
  listMappedStageIds(): Promise<string[]>;
  /** Hydrated set of mapped stages — settings card + composer tab + config DTO. */
  getMappedStages(): Promise<MappedStage[]>;
  /**
   * REPLACE-SET semantics (NOT append): the resulting mapped set is EXACTLY the
   * array received. An empty array clears the config. Any `stageId` that does not
   * correspond to an existing `Stage` MUST reject the WHOLE call — todo-o-nada,
   * the previous config is preserved (never a partial replace).
   */
  replaceMappedStages(stageIds: string[]): Promise<void>;
}
