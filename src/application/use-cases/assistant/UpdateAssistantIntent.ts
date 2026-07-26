import type { AssistantIntentRepository } from '@domain/ports/AssistantProfileRepository';
import type { AssistantCatalogRepository } from '@domain/ports/AssistantCatalogRepository';
import {
  AssistantIntentNameConflictError,
  AssistantIntentNotFoundError,
} from '@domain/errors/assistant';
import { toAssistantIntentDto, type AssistantIntentDto } from '@application/dto/assistant.dto';
import { assertCatalogKeysExist } from './CreateAssistantIntent';

export interface UpdateAssistantIntentCommand {
  name?: string;
  description?: string;
  examples?: string[];
  enabled?: boolean;
  dataSourceKeys?: string[];
  responseGuide?: string;
  actionKey?: string;
}

/**
 * ai-assistant-multiagent (CFG-2/CFG-3/RTR-2) — edita una intención.
 *
 * Valida contra los catálogos con el MISMO helper que el alta: una validación que sólo corre
 * en el `create` es un agujero — editar es el camino por el que la mayoría de las keys
 * inválidas entrarían en la práctica.
 *
 * `enabled:false` la saca del universo del clasificador (RTR-2) sin borrarla: la UI la sigue
 * viendo para poder prenderla de nuevo. Apagar es reversible; borrar, no.
 */
export class UpdateAssistantIntent {
  constructor(
    private readonly intents: AssistantIntentRepository,
    private readonly catalog: AssistantCatalogRepository,
  ) {}

  async execute(id: string, command: UpdateAssistantIntentCommand): Promise<AssistantIntentDto> {
    const existing = await this.intents.findById(id);
    if (!existing) {
      throw new AssistantIntentNotFoundError();
    }

    await assertCatalogKeysExist(this.catalog, command.dataSourceKeys, command.actionKey);

    // El rename tiene que respetar `@@unique([profileId, name])`, y no chocar consigo mismo.
    if (command.name !== undefined && command.name !== existing.name) {
      const siblings = await this.intents.listByProfileId(existing.profileId);
      if (siblings.some((i) => i.id !== id && i.name === command.name)) {
        throw new AssistantIntentNameConflictError();
      }
    }

    const updated = await this.intents.update(id, command);
    if (!updated) {
      throw new AssistantIntentNotFoundError();
    }

    return toAssistantIntentDto(updated);
  }
}
