/**
 * ai-assistant-cobranzas (2.2 / D4) — un mensaje del hilo, CON la señal de origen para la
 * guarda "agente activo" (SEC-6).
 *
 * `role:'agent'` cubre TODO turno saliente (bot o humano) — `generatedByAssistant` es lo que
 * distingue uno de otro. `generatedByAssistant` MUST NOT llegar al prompt del modelo: sólo la
 * consume la guarda pura `evaluateAgentActivity(thread)` en `assistantGuards.ts`; el motor
 * sigue mapeando a `AssistantThreadTurn` (sin el flag) antes de armar el request al modelo.
 */
export interface AssistantThreadMessage {
  role: 'customer' | 'agent';
  text: string;
  generatedByAssistant: boolean;
  /**
   * ai-assistant-cobranzas (2.8 / D11/DAT-4) — nombres de los adjuntos de ESTE mensaje. El
   * motor necesita el `filename` del último inbound para detectar `comprobante_<op>.*` (la
   * excepción del pre-chequeo, D11) sin tener que cargar el binario. Mensaje sin adjuntos ⇒ `[]`.
   */
  attachmentFilenames: string[];
  /**
   * ai-assistant-cobranzas (fix wave W1 / SEC-6) — instante del mensaje (ISO 8601), para la
   * VENTANA de la guarda "agente activo".
   *
   * OPCIONAL en el tipo, pero **su ausencia NO es neutral**: `evaluateAgentActivity` trata un
   * turno de agente humano SIN `at` como ACTIVO (fail-closed). Un reader que se olvide de
   * emitirlo deja al bot callado, nunca hablando encima de una persona.
   */
  at?: string | null;
}

/**
 * ai-assistant-multiagent (CONV-1) — lectura del HILO.
 *
 * Puerto ANGOSTO a propósito: el motor no necesita `ChatMessageRepository` entero (con sus
 * upserts, adjuntos, delivery status y notas internas), sólo los últimos turnos como texto.
 * Un puerto chico se testea con un objeto literal y no arrastra media capa de mensajería a
 * los tests del motor.
 */
export interface AssistantThreadReader {
  /**
   * Últimos `limit` turnos de la conversación, del más viejo al más nuevo.
   *
   * MUST excluir las notas privadas (son conversación interna entre agentes, no del cliente)
   * y los mensajes de sistema. MUST devolver el texto CRUDO: la redacción de PII (SEC-1 /
   * CONV-5) la aplica el motor sobre TODOS los turnos, no el repositorio.
   */
  readRecentTurns(conversationId: string, limit: number): Promise<AssistantThreadMessage[]>;
}
