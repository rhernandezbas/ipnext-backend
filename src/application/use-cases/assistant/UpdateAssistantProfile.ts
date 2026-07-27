import type { AssistantProfileRepository } from '@domain/ports/AssistantProfileRepository';
import type { AssistantCatalogRepository } from '@domain/ports/AssistantCatalogRepository';
import type { AssistantEvalGate } from '@domain/ports/AssistantEvalGate';
import {
  AssistantActionRequiresEvalError,
  AssistantProfileNotFoundError,
  UnknownAssistantActionError,
} from '@domain/errors/assistant';
import { toAssistantProfileDto, type AssistantProfileDto } from '@application/dto/assistant.dto';

export interface UpdateAssistantProfileCommand {
  enabled?: boolean;
  persona?: string;
  handoffMessage?: string;
  model?: string;
  classifierModel?: string | null;
  timeoutMs?: number;
  enabledActions?: string[];
}

/**
 * ai-assistant-multiagent (CFG-1/CFG-3/EVAL-2) — edita el perfil de un área.
 *
 * Dos validaciones que corren ANTES de tocar la base, para que un request inválido no deje
 * estado a medias:
 *
 *  1. **CFG-3** — toda `actionKey` debe existir en el catálogo. Una key inventada se
 *     rechaza con 400: cada acción es una capacidad real del motor, no una etiqueta libre.
 *
 *  2. **EVAL-2** — habilitar una acción `riskLevel:'red'` (cerrar ticket, despachar
 *     cuadrilla) exige una corrida de eval registrada. Sólo se evalúan las acciones red
 *     que se AGREGAN en este request: mantener una ya habilitada no vuelve a pedir eval
 *     (si no, editar la persona de un perfil con `close_ticket` activo sería imposible).
 */
export class UpdateAssistantProfile {
  constructor(
    private readonly profiles: AssistantProfileRepository,
    private readonly catalog: AssistantCatalogRepository,
    private readonly evalGate: AssistantEvalGate,
  ) {}

  async execute(id: string, command: UpdateAssistantProfileCommand): Promise<AssistantProfileDto> {
    const existing = await this.profiles.findById(id);
    if (!existing) {
      throw new AssistantProfileNotFoundError();
    }

    if (command.enabledActions !== undefined) {
      await this.assertActionsAreAllowed(command.enabledActions, existing.enabledActions);
    }

    const updated = await this.profiles.update(id, command);
    if (!updated) {
      // Carrera: el perfil se borró entre el find y el update. Mismo error tipado.
      throw new AssistantProfileNotFoundError();
    }

    return toAssistantProfileDto(updated);
  }

  private async assertActionsAreAllowed(
    requested: string[],
    alreadyEnabled: string[],
  ): Promise<void> {
    // CFG-3 — primero existencia: no tiene sentido evaluar el riesgo de una key inventada.
    const missing = await this.catalog.findMissingActionKeys(requested);
    if (missing.length > 0) {
      throw new UnknownAssistantActionError(missing);
    }

    // EVAL-2 — sólo las red que se AGREGAN ahora.
    const actions = await this.catalog.listActions();
    const riskByKey = new Map(actions.map((a) => [a.key, a.riskLevel]));
    const previouslyEnabled = new Set(alreadyEnabled);

    const newlyEnabledRed = requested.filter(
      (key) => riskByKey.get(key) === 'red' && !previouslyEnabled.has(key),
    );
    if (newlyEnabledRed.length === 0) return;

    const hasEval = await this.evalGate.hasRecordedRun();
    if (!hasEval) {
      throw new AssistantActionRequiresEvalError(newlyEnabledRed);
    }
  }
}
