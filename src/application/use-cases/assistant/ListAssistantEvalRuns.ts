import type { AssistantEvalRepository } from '@domain/ports/AssistantEvalRepository';
import {
  toAssistantEvalRunDto,
  type AssistantEvalRunDto,
} from '@application/dto/assistantEval.dto';

/**
 * ai-assistant-multiagent (EVAL-1) — historial de corridas de evaluación.
 *
 * Existe para que el candado de `resolve_conversation` sea AUDITABLE: sin esta lista, el gate
 * dice "hay una corrida registrada" y nadie puede ver CUÁL, ni con qué números, ni de cuándo.
 * Un candado que no se puede inspeccionar se convierte en un trámite: alguien registra
 * cualquier cosa una vez y queda destrabado para siempre sin que se note.
 */

/** Techo del historial. Una pantalla no puede crecer sin límite y nadie audita 500 corridas. */
const MAX_RUNS = 50;

export class ListAssistantEvalRuns {
  constructor(private readonly evals: AssistantEvalRepository) {}

  async execute(): Promise<AssistantEvalRunDto[]> {
    const runs = await this.evals.list(MAX_RUNS);
    return runs.map(toAssistantEvalRunDto);
  }
}
