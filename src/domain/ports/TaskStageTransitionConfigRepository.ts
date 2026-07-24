import { MappedStage } from './TaskStageRecipientConfigRepository';

/**
 * bulk-task-stage-transition (D1, TTC-1/TTC-2) — port for the SINGLETON transition
 * config: the ONE global `Stage` (B) tasks transition to when the bulk sends them.
 * Molde: `NocBroadcastConfigRepository` (single-row config). SEPARATE from
 * `TaskStageRecipientConfigRepository` (the eligible-stages SET) — narrow port per
 * capability (disciplina D-pattern).
 *
 * `resultingStageId === null` means "no transition configured" — the task bulk keeps
 * working as a pure recipient filter (comportamiento de `bulk-task-recipients`).
 */
export interface TaskStageTransitionConfigRepository {
  /** Bare id of the single global destino, or `null` if none configured. */
  getResultingStageId(): Promise<string | null>;
  /** Hydrated view of the destino (name/code/color/workflow) for the settings card, or `null`. */
  getResultingStage(): Promise<MappedStage | null>;
  /** REPLACE semantics: the destino becomes EXACTLY `stageId` (or `null` to clear). */
  setResultingStageId(stageId: string | null): Promise<void>;
}
