import type { ChatMessageRepository } from '@domain/ports/ChatMessageRepository';
import type { ChatMessageAttachmentRepository } from '@domain/ports/ChatMessageAttachmentRepository';
import type {
  AssistantThreadReader,
  AssistantThreadMessage,
} from '@domain/ports/AssistantThreadReader';

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

export interface ChatMessageThreadReaderOptions {
  /**
   * ai-assistant-cobranzas (4.6 / D4 / SEC-6) — nombres de remitente con los que el propio
   * asistente aparece en el espejo (el `senderName` que Chatwoot ecoa cuando el mensaje sale
   * por nuestro token de API).
   *
   * ⚠️ **Lista blanca, y el default vacío es deliberado.** La asimetría de esta señal es
   * total: marcar de MENOS ("esto lo escribió un humano" cuando fue el bot) sólo hace que el
   * motor se calle de más; marcar de MÁS ("lo escribió el bot" cuando fue un agente) hace que
   * la guarda SEC-6 no dispare y el asistente le hable ENCIMA a una persona que está
   * atendiendo. Por eso no hay heurística ("empieza con 🤖", "salió por nuestra API"): lo que
   * no está explícitamente declarado como el bot, es un humano.
   *
   * Sin lista, la guarda queda del lado cauto (todo saliente = agente humano).
   */
  assistantSenderNames?: string[];
}

export class ChatMessageThreadReader implements AssistantThreadReader {
  private readonly assistantSenders: Set<string>;

  constructor(
    private readonly messages: ChatMessageRepository,
    /**
     * ai-assistant-cobranzas (4.11 / D11 / DAT-4) — espejo de adjuntos. OPCIONAL: sin él, el
     * hilo se lee igual y `attachmentFilenames` queda `[]` — la excepción del comprobante
     * simplemente no se activa (el lado seguro: sin nombre de archivo no se INVENTA un
     * comprobante), y ningún call site viejo se rompe.
     */
    private readonly attachments?: ChatMessageAttachmentRepository,
    options: ChatMessageThreadReaderOptions = {},
  ) {
    this.assistantSenders = new Set(
      (options.assistantSenderNames ?? []).map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0),
    );
  }

  async readRecentTurns(conversationId: string, limit: number): Promise<AssistantThreadMessage[]> {
    const all = await this.messages.listByConversation(conversationId);

    const visible = all
      .filter((m) => !m.isPrivate && !m.deletedAt)
      .filter((m) => m.content.trim().length > 0)
      // Los últimos `limit`, en orden cronológico: el modelo necesita leer la charla como
      // la leería una persona, del principio del tramo al final.
      .slice(-limit);

    // UNA sola consulta de adjuntos para todo el tramo — un `listByMessageId` por turno
    // sería un N+1 en el camino caliente del motor (hasta 20 queries por webhook).
    const filenamesByMessage = await this.loadFilenames(visible.map((m) => m.id));

    return visible.map((m) => {
      const isInbound = m.direction === 'inbound';
      return {
        role: isInbound ? ('customer' as const) : ('agent' as const),
        text: m.content,
        // Un mensaje ENTRANTE jamás lo generó el asistente, diga lo que diga la config: un
        // `senderName` del cliente que coincidiera con la lista blanca no puede convertir su
        // mensaje en "del bot" (y con eso apagar la guarda del turno siguiente).
        generatedByAssistant: !isInbound && this.isAssistantSender(m.senderName),
        attachmentFilenames: filenamesByMessage.get(m.id) ?? [],
        // fix wave W1 (SEC-6) — la VENTANA de "hay un humano atendiendo" necesita un reloj.
        // Se usa `createdAt` (cuándo entró al espejo) y no `chatwootCreatedAt`: es el instante
        // que el propio sistema observó. En tráfico vivo difieren en milisegundos, y en un
        // backfill `createdAt` es reciente ⇒ la guarda queda del lado cauto, que es el correcto.
        at: m.createdAt ?? null,
      };
    });
  }

  private isAssistantSender(senderName: string | null): boolean {
    if (!senderName) return false;
    return this.assistantSenders.has(senderName.trim().toLowerCase());
  }

  private async loadFilenames(messageIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!this.attachments || messageIds.length === 0) return out;

    const rows = await this.attachments.listByMessageIds(messageIds);
    for (const row of rows) {
      // Un adjunto sin `filename` (Chatwoot no siempre lo reporta) no aporta nada al match
      // del comprobante y no se emite: un `null` en la lista sólo sería ruido para el regex.
      if (!row.filename) continue;
      const list = out.get(row.messageId) ?? [];
      list.push(row.filename);
      out.set(row.messageId, list);
    }
    return out;
  }
}
