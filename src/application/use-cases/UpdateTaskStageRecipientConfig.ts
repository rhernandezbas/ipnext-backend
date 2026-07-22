import { MappedStage, TaskStageRecipientConfigRepository } from '@domain/ports/TaskStageRecipientConfigRepository';

export interface UpdateTaskStageRecipientConfigInput {
  stageIds: string[];
}

/**
 * bulk-task-recipients (B3.2, TSC-1, TSC-4, D2/D6) — reemplaza el set de
 * `Stage` mapeados (replace-set, NO append). Molde `UpdateNocBroadcastConfig`.
 *
 * Dedup ANTES de persistir (TSC-1 "mapear el mismo stage dos veces es
 * imposible"): la constraint `@unique` de la DB es la última línea de
 * defensa, NO la única. La atomicidad todo-o-nada (un `stageId` inexistente
 * rechaza TODO el call, config previa intacta) la garantiza el REPO
 * (transacción/validación, D2) — este use case NO hace un pre-chequeo de
 * existencia separado antes de llamar `replaceMappedStages` (evita una query
 * extra redundante, ver desvío #2 de tasks.md).
 */
export class UpdateTaskStageRecipientConfig {
  constructor(private readonly config: TaskStageRecipientConfigRepository) {}

  async execute(input: UpdateTaskStageRecipientConfigInput): Promise<{ stages: MappedStage[] }> {
    const deduped = [...new Set(input.stageIds)];
    await this.config.replaceMappedStages(deduped);
    return { stages: await this.config.getMappedStages() };
  }
}
