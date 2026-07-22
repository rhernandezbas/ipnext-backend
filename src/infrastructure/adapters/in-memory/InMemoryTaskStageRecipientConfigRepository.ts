import {
  MappedStage,
  TaskStageRecipientConfigRepository,
} from '@domain/ports/TaskStageRecipientConfigRepository';
import { TaskStageNotFoundError } from '@domain/errors/messaging-task-stage-config';

/** Fixture shape for a `Stage` in the catalog — mirrors the `Stage` universe (test-only). */
export interface StageCatalogEntry {
  name: string;
  code: string;
  color: string | null;
  workflowId: string;
  workflowName: string;
}

/**
 * bulk-task-recipients (B2.3, D2) — in-memory mirror of the config-CRUD port. A
 * fixture catalog (`stageId -> StageCatalogEntry`) mirrors the `Stage` universe;
 * an internal `Set<string>` holds the currently mapped stageIds.
 * `replaceMappedStages` validates EVERY id against the catalog BEFORE mutating the
 * Set — mirrors the real FK: an unknown id rejects the whole call, the previous
 * config is never touched (todo-o-nada).
 */
export class InMemoryTaskStageRecipientConfigRepository implements TaskStageRecipientConfigRepository {
  private mapped: Set<string>;

  constructor(
    private readonly catalog: Record<string, StageCatalogEntry> = {},
    initialMapped: string[] = [],
  ) {
    this.mapped = new Set(initialMapped);
  }

  async listMappedStageIds(): Promise<string[]> {
    return Array.from(this.mapped);
  }

  async getMappedStages(): Promise<MappedStage[]> {
    return Array.from(this.mapped).map((stageId) => {
      const entry = this.catalog[stageId];
      // fix wave (F4, LOW, higiene) — guard defensivo: un stageId mapeado que ya NO
      // está en el catálogo (fixture inconsistente — inalcanzable vía
      // `replaceMappedStages`, que SÍ valida, pero alcanzable vía el 2do arg del
      // constructor) rechaza con un error CLARO, no un `TypeError` crudo
      // (`Cannot read properties of undefined`).
      if (!entry) {
        throw new TaskStageNotFoundError(
          `getMappedStages: stageId '${stageId}' está mapeado pero no existe en el catálogo`,
        );
      }
      return {
        stageId,
        stageName: entry.name,
        stageCode: entry.code,
        color: entry.color,
        workflowId: entry.workflowId,
        workflowName: entry.workflowName,
      };
    });
  }

  async replaceMappedStages(stageIds: string[]): Promise<void> {
    const unknown = stageIds.filter((id) => !(id in this.catalog));
    if (unknown.length > 0) {
      throw new TaskStageNotFoundError();
    }
    this.mapped = new Set(stageIds);
  }
}
