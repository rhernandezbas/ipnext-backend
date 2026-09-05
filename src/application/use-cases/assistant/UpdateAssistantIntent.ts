import type { AssistantIntentRepository } from '@domain/ports/AssistantProfileRepository';
import type { AssistantCatalogRepository } from '@domain/ports/AssistantCatalogRepository';
import {
  AssistantIntentNameConflictError,
  AssistantIntentNotFoundError,
} from '@domain/errors/assistant';
import { toAssistantIntentDto, type AssistantIntentDto } from '@application/dto/assistant.dto';
import { assertCatalogKeysExist, assertRoleKeyIsFree, assertTriggerPatternsAllowed } from './CreateAssistantIntent';

export interface UpdateAssistantIntentCommand {
  name?: string;
  description?: string;
  examples?: string[];
  enabled?: boolean;
  dataSourceKeys?: string[];
  responseGuide?: string;
  actionKey?: string;
  /** ai-assistant-cobranzas (D2) — `undefined` = no tocar. */
  labels?: string[];
  /** ai-assistant-cobranzas (D5) — `undefined` = no tocar. Validado por CFG-2 (ver abajo). */
  triggerPatterns?: string[];
  /** ai-assistant-cobranzas (D10) — `undefined` = no tocar. */
  unassign?: boolean;
  /** ai-assistant-cobranzas (D11) — `undefined` = no tocar; `null` = limpiar. */
  roleKey?: string | null;
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
    // CFG-2 (D5) — valida el resultado EFECTIVO del patch, no sólo lo que este request toca:
    // cambiar `actionKey` a uno no-handoff mientras quedan `triggerPatterns` vigentes de un
    // patch anterior es el MISMO incumplimiento que setearlos ahora.
    const effectiveActionKey = command.actionKey ?? existing.actionKey;
    const effectiveTriggerPatterns = command.triggerPatterns ?? existing.triggerPatterns;
    assertTriggerPatternsAllowed(effectiveTriggerPatterns, effectiveActionKey);

    // El rename tiene que respetar `@@unique([profileId, name])`, y no chocar consigo mismo.
    // CFG-2 (D11) — y el `roleKey` tiene que seguir siendo único DENTRO del perfil: el
    // selector 4b resuelve por rol y se queda con la primera fila que matchea.
    const needsSiblings =
      (command.name !== undefined && command.name !== existing.name) || command.roleKey !== undefined;
    if (needsSiblings) {
      const siblings = await this.intents.listByProfileId(existing.profileId);
      if (
        command.name !== undefined &&
        command.name !== existing.name &&
        siblings.some((i) => i.id !== id && i.name === command.name)
      ) {
        throw new AssistantIntentNameConflictError();
      }
      assertRoleKeyIsFree(command.roleKey, siblings, id);
    }

    const updated = await this.intents.update(id, command);
    if (!updated) {
      throw new AssistantIntentNotFoundError();
    }

    return toAssistantIntentDto(updated);
  }
}
