import type { AssistantConversationGateway } from '@domain/ports/AssistantConversationGateway';
import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ChatwootGateway } from '@domain/ports/ChatwootGateway';
import type { SendMessage } from '@application/use-cases/messaging/SendMessage';
import type { SetConversationArea } from '@application/use-cases/messaging/SetConversationArea';
import type { SetConversationStatus } from '@application/use-cases/messaging/SetConversationStatus';
import type { AssignConversation } from '@application/use-cases/messaging/AssignConversation';

/**
 * ai-assistant-multiagent (RUN-3 / D11) — salida del motor hacia la conversación.
 *
 * **El bot no tiene camino propio de escritura.** Cada método delega en el use case que ya
 * usan los humanos, así hereda gratis el espejado en `ChatMessage`, el bump del preview, la
 * auditoría y el historial de eventos. Un segundo camino de escritura sería un segundo lugar
 * donde el mirror puede divergir de Chatwoot.
 *
 * ── Excepción documentada: los labels ───────────────────────────────────────
 * `applyLabels` llama a `ChatwootGateway.addConversationLabels` DIRECTO, y no a
 * `SetConversationLabels`. No es una violación de RUN-3, son dos sistemas distintos:
 *   - `SetConversationLabels` maneja las etiquetas LOCALES de Prominense
 *     (`ConversationLabelRepository`) — no las ve nadie en Chatwoot.
 *   - `ChatwootGateway.addConversationLabels` aplica la etiqueta EN Chatwoot, que es donde
 *     trabajan los agentes (D11). Sin esto, el rastro del bot sería invisible.
 * Mismo precedente que `SendCampaign` (`SendCampaign.ts:414`), y no hay mirror local de
 * labels de Chatwoot que pueda quedar desincronizado.
 *
 * `actorId: null` en todos los use cases: el bot no es un usuario RBAC. Los eventos quedan
 * con actor nulo, igual que los que dispara el propio Chatwoot.
 */
export class ChatwootAssistantConversationGateway implements AssistantConversationGateway {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly sendMessage: SendMessage,
    private readonly setAreaUseCase: SetConversationArea,
    private readonly setStatus: SetConversationStatus,
    private readonly chatwoot: ChatwootGateway,
    /**
     * ai-assistant-cobranzas (D10/ACT-4) — OPCIONAL para no romper los call sites que
     * todavía no lo pasan: sin él, `unassign` desasigna sólo en Chatwoot y lo deja logueado
     * (mejor un lado que ninguno, y el log dice cuál falta). La composición real lo inyecta.
     */
    private readonly assign?: AssignConversation,
  ) {}

  /** 🟡 Mensaje al cliente. Va por `SendMessage` ⇒ se espeja y bumpea el preview. */
  async reply(conversationId: string, text: string): Promise<void> {
    await this.sendMessage.execute(conversationId, text);
  }

  /**
   * 🟢 Nota privada EN CHATWOOT (`isPrivate = true`). La ve el agente, el cliente no.
   * `SendMessage` con `isPrivate` saltea el guard de la ventana de 24 h a propósito: una nota
   * nunca cruza a WhatsApp, así que la regla de Meta no le aplica. Por eso el aviso de handoff
   * funciona incluso fuera de ventana — que es justo cuando más se necesita.
   */
  async privateNote(conversationId: string, text: string): Promise<void> {
    await this.sendMessage.execute(conversationId, text, [], true);
  }

  /** 🟢 Etiqueta EN Chatwoot (ver excepción documentada arriba). */
  async applyLabels(conversationId: string, labels: string[]): Promise<void> {
    const conversation = await this.conversations.findById(conversationId);
    // Sin `chatwootConversationId` la conversación todavía no existe upstream (caso bulk
    // pre-adopción): no hay dónde poner la etiqueta. No es un error, es un no-op.
    if (!conversation?.chatwootConversationId) return;

    await this.chatwoot.addConversationLabels(conversation.chatwootConversationId, labels);
  }

  /** 🟢 Reclasificación — deja el evento `area_changed` en el feed (RTR-1). */
  async setArea(conversationId: string, areaId: string): Promise<void> {
    await this.setAreaUseCase.execute(conversationId, areaId, null);
  }

  /** 🔴 Marcar resuelta. Requiere eval registrado para habilitarse (EVAL-2). */
  async resolve(conversationId: string): Promise<void> {
    await this.setStatus.execute(conversationId, 'resolved', null);
  }

  /**
   * 🟢 ai-assistant-cobranzas (4.10 / D10 / ACT-4) — desasigna la conversación EN LOS DOS
   * LADOS, y ése es todo el punto del método.
   *
   * ⚠️ Verificado: `AssignConversation` escribe `Conversation.assigneeId`, un campo LOCAL del
   * espejo — **nunca llama a Chatwoot**. Y los agentes trabajan en Chatwoot (D11), donde la
   * guarda SEC-6 lee `conversation.meta.assignee`. Sólo local ⇒ el agente la sigue viendo
   * suya y la regla no cumple su fin; sólo Chatwoot ⇒ el inbox de Prominense muestra un dueño
   * fantasma. Por eso son dos llamadas, y por eso ninguna puede impedir la otra.
   *
   * BEST-EFFORT y AISLADO por lado: esto corre DESPUÉS de que el mensaje ya salió (orden
   * acción → labels → unassign, D10). Un fallo de infraestructura acá no puede tumbar una
   * respuesta enviada (RUN-1), y el fallo de UN lado no puede saltearse el otro.
   */
  async unassign(conversationId: string): Promise<void> {
    // Lado 1 — espejo local (inbox de Prominense). `actorId: null`: el bot no es RBAC.
    await this.safely('local', () => this.assign?.execute(conversationId, null, null));

    // Lado 2 — Chatwoot, que es donde el agente humano la ve asignada.
    await this.safely('chatwoot', async () => {
      const conversation = await this.conversations.findById(conversationId);
      // Sin `chatwootConversationId` la conversación no existe upstream todavía (bulk
      // pre-adopción): no hay a quién desasignar. No es un error, es un no-op.
      if (!conversation?.chatwootConversationId) return;
      await this.chatwoot.unassignConversation(conversation.chatwootConversationId);
    });
  }

  /** Cada lado del `unassign` se aísla: un fallo no impide el otro ni propaga (RUN-1). */
  private async safely(lado: string, fn: () => Promise<unknown> | undefined): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[assistant] unassign falló de un lado (best-effort)', {
        lado,
        error: err instanceof Error ? err.message : err,
      });
    }
  }
}
