import type { ChatMessageRepository } from '@domain/ports/ChatMessageRepository';
import type { AssistantThreadReader } from '@domain/ports/AssistantThreadReader';
import type { AssistantThreadTurn } from '@domain/ports/AssistantRuntime';

/**
 * ai-assistant-multiagent (CONV-1) — el HILO, desde el mirror que ya existe.
 *
 * Filtra dos cosas, y las dos importan:
 *
 *  1. **Notas privadas** — son conversación INTERNA entre agentes ("ojo que este cliente ya
 *     reclamó tres veces"). Mandárselas al modelo lo haría responder a comentarios que el
 *     cliente nunca escribió, y podría hacerle repetir información interna.
 *  2. **Mensajes borrados** (`deletedAt`) — si alguien borró una nota, no debe resucitar
 *     dentro de un prompt.
 *
 * Devuelve el texto CRUDO: la redacción de PII la aplica el motor sobre todos los turnos
 * (SEC-1/CONV-5). Mezclar las dos responsabilidades acá haría que un futuro consumidor del
 * repositorio creyera que el texto ya viene saneado.
 */
export class ChatMessageThreadReader implements AssistantThreadReader {
  constructor(private readonly messages: ChatMessageRepository) {}

  async readRecentTurns(conversationId: string, limit: number): Promise<AssistantThreadTurn[]> {
    const all = await this.messages.listByConversation(conversationId);

    return all
      .filter((m) => !m.isPrivate && !m.deletedAt)
      .filter((m) => m.content.trim().length > 0)
      // Los últimos `limit`, en orden cronológico: el modelo necesita leer la charla como
      // la leería una persona, del principio del tramo al final.
      .slice(-limit)
      .map((m) => ({
        role: m.direction === 'inbound' ? ('customer' as const) : ('assistant' as const),
        text: m.content,
      }));
  }
}
