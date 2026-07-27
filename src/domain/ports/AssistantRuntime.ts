/**
 * ai-assistant-multiagent (RUN-1, design D1) — puerto hacia el modelo.
 *
 * ⚠️ **MUST NOT THROW.** Molde `InstallationAuditor`. Ninguno de estos métodos lanza: un
 * fallo (timeout, 4xx/5xx, JSON malformado, salida inválida) se devuelve como
 * `{ kind: 'unavailable' }`. La unión discriminada hace que el contrato sea de COMPILACIÓN,
 * no de disciplina: el caller está obligado a contemplar el caso.
 *
 * Dos operaciones separadas a propósito (D1): entre `classify` y `generate` corre CÓDIGO
 * determinístico que decide si se sigue. Con una sola llamada + tools, quien respetaría la
 * allowlist sería el modelo.
 */

/** Un turno del hilo, YA redactado de PII (SEC-1/CONV-5) antes de llegar acá. */
export interface AssistantThreadTurn {
  role: 'customer' | 'assistant';
  text: string;
}

/**
 * Una candidata para el clasificador.
 *
 * `key` es un handle OPACO que el motor genera y usa para mapear la respuesta de vuelta a
 * (perfil, área, intención). Existe por el re-ruteo (RTR-0): cuando se clasifica contra las
 * intenciones de VARIAS áreas, dos áreas distintas pueden tener una intención con el mismo
 * `name` ("estado de cuenta" en Facturación y en Soporte). Sin un handle único, la respuesta
 * del modelo sería ambigua y el motor tendría que adivinar a qué área rutear.
 */
export interface AssistantClassifyCandidate {
  key: string;
  name: string;
  description: string;
  examples: string[];
}

export interface AssistantClassifyRequest {
  model: string;
  persona: string;
  /** El HILO, no el último mensaje (CONV-1). */
  thread: AssistantThreadTurn[];
  /**
   * Universo CERRADO de candidatas. En la clasificación normal son las intents `enabled` del
   * perfil del área (RTR-2). En el re-ruteo, las de las OTRAS áreas con agente habilitado.
   */
  candidates: AssistantClassifyCandidate[];
  timeoutMs: number;
}

/**
 * - `intent`       — el hilo matchea un tema habilitado ⇒ modo INFORMAR.
 * - `chat`         — saludo/gracias/repregunta ⇒ modo CONVERSAR (sin hechos, CONV-2).
 * - `out_of_scope` — piden algo que el perfil no cubre ⇒ DERIVAR.
 * - `unavailable`  — el modelo no respondió. NO es lo mismo que "no matcheó": el motor
 *                    degrada a no-op en vez de tratarlo como fuera de alcance.
 */
export type AssistantClassifyResult =
  | { kind: 'intent'; key: string }
  | { kind: 'chat' }
  | { kind: 'out_of_scope' }
  | { kind: 'unavailable' };

export interface AssistantGenerateRequest {
  model: string;
  persona: string;
  /** Guía de la intención ganadora. Vacío en modo CONVERSAR. */
  responseGuide: string;
  thread: AssistantThreadTurn[];
  /**
   * Hechos ya resueltos y verificados libres de PII. **`null` = modo CONVERSAR**: sin hechos,
   * el whitelist de SEC-4 queda vacío y ninguna cifra es válida (CONV-3).
   */
  facts: Record<string, unknown> | null;
  timeoutMs: number;
}

/**
 * `cannot_answer` es el centinela `NO_PUEDO_RESPONDER` (design D8): la vía por la que el
 * propio modelo pide handoff. Barata y determinística de detectar — no depende de
 * interpretar su prosa.
 */
export type AssistantGenerateResult =
  | { kind: 'text'; text: string }
  | { kind: 'cannot_answer' }
  | { kind: 'unavailable' };

export interface AssistantRuntime {
  classify(request: AssistantClassifyRequest): Promise<AssistantClassifyResult>;
  generate(request: AssistantGenerateRequest): Promise<AssistantGenerateResult>;
}
