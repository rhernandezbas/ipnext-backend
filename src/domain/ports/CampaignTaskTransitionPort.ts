/**
 * bulk-task-stage-transition (D4, TRANS-1..3) — port narrow que `SendCampaign` invoca
 * (aislado/best-effort) para transicionar la tarea de un recipient `source:'task'` tras
 * salir `sent`. SEPARADO del modelo de scheduling: messaging NO conoce SchedulingRepository/
 * StageRepository, solo este contrato. El adapter (`TransitionTaskAfterSend`) compone el
 * guard still-in-A + el guard anti-send_to_iclass + reusa `MoveTaskToStage`.
 */
export type TaskTransitionOutcome =
  | 'moved'
  | 'skipped_not_in_origin' // TRANS-2: la tarea ya no está en A (humano la movió / no existe)
  | 'skipped_iclass'; // TRANS-3: el destino resultó send_to_iclass (red de seguridad)

export interface CampaignTaskTransitionPort {
  transition(input: { taskId: string; fromStageId: string; toStageId: string }): Promise<TaskTransitionOutcome>;
}
