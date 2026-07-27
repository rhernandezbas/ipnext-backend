import type { AssistantThreadTurn } from './AssistantRuntime';

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
  readRecentTurns(conversationId: string, limit: number): Promise<AssistantThreadTurn[]>;
}
