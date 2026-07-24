import { MappedStage } from '@domain/ports/TaskStageRecipientConfigRepository';
import { TaskStageTransitionConfigRepository } from '@domain/ports/TaskStageTransitionConfigRepository';

/**
 * bulk-task-stage-transition (B1.6, TTC-4) — devuelve el estado resultante ÚNICO
 * GLOBAL hidratado (o `null` si no hay). Molde `GetTaskStageRecipientConfig`: delega
 * directo en el repo, sin transformación propia. La ruta compone este `{ resultingStage }`
 * con el `{ stages }` de `GetTaskStageRecipientConfig` en una sola respuesta.
 */
export class GetTaskStageTransitionConfig {
  constructor(private readonly config: TaskStageTransitionConfigRepository) {}

  async execute(): Promise<{ resultingStage: MappedStage | null }> {
    return { resultingStage: await this.config.getResultingStage() };
  }
}
