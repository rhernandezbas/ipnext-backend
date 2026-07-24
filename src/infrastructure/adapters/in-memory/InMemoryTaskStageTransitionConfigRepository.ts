import { MappedStage } from '@domain/ports/TaskStageRecipientConfigRepository';
import { TaskStageTransitionConfigRepository } from '@domain/ports/TaskStageTransitionConfigRepository';
import { StageCatalogEntry } from './InMemoryTaskStageRecipientConfigRepository';

/**
 * bulk-task-stage-transition (B1.4, D1) — in-memory mirror of the singleton
 * transition-config port. A fixture catalog (`stageId -> StageCatalogEntry`) hydrates
 * `getResultingStage`; an internal nullable `resultingStageId` holds the single global
 * destino. A stored id that is NOT in the catalog (stage borrado — inalcanzable vía el
 * use case, que valida) hidrata a `null` (degradación segura, molde del `SetNull` real).
 */
export class InMemoryTaskStageTransitionConfigRepository implements TaskStageTransitionConfigRepository {
  private resultingStageId: string | null;

  constructor(
    private readonly catalog: Record<string, StageCatalogEntry> = {},
    initial: string | null = null,
  ) {
    this.resultingStageId = initial;
  }

  async getResultingStageId(): Promise<string | null> {
    return this.resultingStageId;
  }

  async getResultingStage(): Promise<MappedStage | null> {
    if (this.resultingStageId === null) return null;
    const entry = this.catalog[this.resultingStageId];
    if (!entry) return null; // stage borrado / fixture inconsistente → sin destino
    return {
      stageId: this.resultingStageId,
      stageName: entry.name,
      stageCode: entry.code,
      color: entry.color,
      workflowId: entry.workflowId,
      workflowName: entry.workflowName,
    };
  }

  async setResultingStageId(stageId: string | null): Promise<void> {
    this.resultingStageId = stageId;
  }
}
