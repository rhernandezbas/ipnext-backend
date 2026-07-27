import type {
  AssistantEvalRepository,
  RecordAssistantEvalRunInput,
} from '@domain/ports/AssistantEvalRepository';
import { InvalidAssistantEvalRunError } from '@domain/errors/assistant';
import {
  toAssistantEvalRunDto,
  type AssistantEvalRunDto,
} from '@application/dto/assistantEval.dto';

/**
 * ai-assistant-multiagent (EVAL-1) — registra una corrida de evaluación.
 *
 * ⚠️ **Exige que la partición de ABSTENCIÓN tenga casos.** Una corrida que sólo mide
 * resolución no es un eval a medias: es un eval que mide lo fácil e ignora el modo de falla
 * peligroso. Aceptarla dejaría habilitar acciones de riesgo con un número que no dice nada
 * sobre si el bot sabe callarse — que es justamente lo que el candado quiere garantizar.
 *
 * Los porcentajes se derivan al leer, nunca se persisten: guardar un promedio junto a sus
 * componentes es invitar a que queden desincronizados.
 */
export class RecordAssistantEvalRun {
  constructor(private readonly evals: AssistantEvalRepository) {}

  async execute(input: RecordAssistantEvalRunInput): Promise<AssistantEvalRunDto> {
    assertValid(input);

    const run = await this.evals.record(input);

    // Mismo mapper que el listado: dos formas de derivar la misma tasa es cómo terminan
    // mostrando números distintos para la misma corrida.
    return toAssistantEvalRunDto(run);
  }
}

function assertValid(input: RecordAssistantEvalRunInput): void {
  const problems: string[] = [];

  if (input.resolutionTotal < 0 || input.abstentionTotal < 0) {
    problems.push('los totales no pueden ser negativos');
  }
  if (input.resolutionCorrect > input.resolutionTotal) {
    problems.push('resolutionCorrect no puede superar resolutionTotal');
  }
  if (input.abstentionCorrect > input.abstentionTotal) {
    problems.push('abstentionCorrect no puede superar abstentionTotal');
  }
  // La regla de fondo: sin partición de abstención, esto no es un eval.
  if (input.abstentionTotal === 0) {
    problems.push(
      'la partición de abstención no puede estar vacía: un eval que sólo mide resolución ignora el modo de falla peligroso',
    );
  }
  if (input.resolutionTotal === 0) {
    problems.push('la partición de resolución no puede estar vacía');
  }

  if (problems.length > 0) {
    throw new InvalidAssistantEvalRunError(problems);
  }
}
