import { MappedStage, TaskStageRecipientConfigRepository } from '@domain/ports/TaskStageRecipientConfigRepository';

/**
 * bulk-task-recipients (B3.1, TSC-3, D6) — devuelve el set de `Stage` mapeados
 * como criterio de destinatarios del 5to dominio "Tarea". Molde
 * `GetNocBroadcastConfig`: delega DIRECTO en el repo, sin transformación
 * propia (no hay masking acá — el mapeo de stages no es un secreto).
 */
export class GetTaskStageRecipientConfig {
  constructor(private readonly config: TaskStageRecipientConfigRepository) {}

  async execute(): Promise<{ stages: MappedStage[] }> {
    return { stages: await this.config.getMappedStages() };
  }
}
