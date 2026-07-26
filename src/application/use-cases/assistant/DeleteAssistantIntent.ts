import type { AssistantIntentRepository } from '@domain/ports/AssistantProfileRepository';
import { AssistantIntentNotFoundError } from '@domain/errors/assistant';

/**
 * ai-assistant-multiagent (CFG-2) — borra una intención.
 *
 * Nota de producto: borrar es DESTRUCTIVO e irreversible; apagar (`enabled:false`) deja la
 * fila y su historial. El FE debe ofrecer apagar como acción primaria y borrar detrás de una
 * confirmación — pero eso es decisión de la UI, no de este use case, que sólo cumple la orden.
 */
export class DeleteAssistantIntent {
  constructor(private readonly intents: AssistantIntentRepository) {}

  async execute(id: string): Promise<void> {
    const deleted = await this.intents.delete(id);
    if (!deleted) {
      throw new AssistantIntentNotFoundError();
    }
  }
}
