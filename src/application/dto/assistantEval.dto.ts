import type { AssistantEvalRun } from '@domain/ports/AssistantEvalRepository';

/**
 * ai-assistant-multiagent (EVAL-1) — una corrida de evaluación, como se lee.
 *
 * Se exponen las TASAS y los TOTALES, no los conteos de aciertos: el total dice el tamaño de
 * la muestra (una tasa del 100% sobre 3 casos no significa nada) y la tasa dice el resultado.
 * Mandar además los "correct" sería mandar el mismo dato dos veces y habilitar que la UI
 * calcule su propio promedio, que es cómo se desincronizan.
 *
 * Las dos particiones van SEPARADAS a propósito, nunca promediadas:
 *  - **resolución** — ¿acierta cuando la respuesta existe?
 *  - **abstención** — ¿se calla cuando NO existe?
 *
 * Colapsarlas esconde el modo de falla peligroso. El benchmark de IrisAgent sobre tickets
 * reales lo mostró crudo: el modelo que más resolvía era el PEOR resistiendo alucinaciones.
 * Un promedio único lo habría dejado primero.
 */
export interface AssistantEvalRunDto {
  id: string;
  model: string;
  /** Aciertos sobre casos con respuesta conocida. `null` si la partición vino vacía. */
  resolutionAccuracy: number | null;
  /** **La métrica que importa**: cuántas veces se calló cuando debía. `null` si vacía. */
  abstentionRate: number | null;
  /** Tamaño de cada muestra — sin esto una tasa no se puede interpretar. */
  resolutionTotal: number;
  abstentionTotal: number;
  notes: string | null;
  createdAt: string;
}

/** Los porcentajes se derivan al leer, NUNCA se persisten: un promedio guardado junto a sus
 *  componentes es una desincronización esperando ocurrir. */
export function toAssistantEvalRunDto(run: AssistantEvalRun): AssistantEvalRunDto {
  return {
    id: run.id,
    model: run.model,
    resolutionAccuracy: ratio(run.resolutionCorrect, run.resolutionTotal),
    abstentionRate: ratio(run.abstentionCorrect, run.abstentionTotal),
    resolutionTotal: run.resolutionTotal,
    abstentionTotal: run.abstentionTotal,
    notes: run.notes,
    createdAt: run.createdAt,
  };
}

function ratio(correct: number, total: number): number | null {
  return total === 0 ? null : Number((correct / total).toFixed(4));
}
