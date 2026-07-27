/**
 * ai-assistant-multiagent (EVAL-1/EVAL-2) — corridas de evaluación.
 *
 * El eval NO es una métrica linda para un tablero: es el **candado** de las acciones de riesgo.
 * Sin una corrida registrada, `resolve_conversation` no se puede habilitar (EVAL-2).
 *
 * Se miden DOS cosas por separado, y esa separación es el punto entero:
 *  - **resolución** — ¿acierta cuando la respuesta existe?
 *  - **abstención** — ¿se calla cuando NO existe?
 *
 * Colapsarlas en un solo "accuracy" esconde el modo de falla que importa. El benchmark de
 * IrisAgent sobre tickets reales (jul-2026) lo mostró crudo: Gemini 3 Flash resuelve casi todo
 * y es el PEOR resistiendo alucinaciones — "peligroso cuando no hay respuesta". Un promedio
 * único lo habría dejado primero en el ranking.
 */
export interface AssistantEvalRun {
  id: string;
  /** Modelo evaluado, tal como se configuró en el perfil. */
  model: string;
  /** Casos de la partición de RESOLUCIÓN (la respuesta correcta existe y se conoce). */
  resolutionTotal: number;
  resolutionCorrect: number;
  /** Casos de la partición de ABSTENCIÓN (no hay respuesta buena; hay que callarse). */
  abstentionTotal: number;
  /** Cuántas veces se calló correctamente. */
  abstentionCorrect: number;
  /** Notas del operador (qué se corrió, sobre qué muestra). Nunca contenido de clientes. */
  notes: string | null;
  createdAt: string;
}

export interface RecordAssistantEvalRunInput {
  model: string;
  resolutionTotal: number;
  resolutionCorrect: number;
  abstentionTotal: number;
  abstentionCorrect: number;
  notes: string | null;
}

export interface AssistantEvalRepository {
  record(input: RecordAssistantEvalRunInput): Promise<AssistantEvalRun>;
  list(limit: number): Promise<AssistantEvalRun[]>;
  /** EVAL-2 — ¿existe al menos una corrida? Es la pregunta que hace el gate. */
  hasAnyRun(): Promise<boolean>;
}
