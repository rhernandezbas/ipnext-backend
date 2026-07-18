import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ChatwootGateway } from '@domain/ports/ChatwootGateway';
import type { ConversationEventRepository } from '@domain/ports/ConversationEventRepository';
import {
  ConversationNotFoundError,
  ChatwootUnavailableError,
  InvalidConversationStatusError,
} from '@domain/errors/messaging';
import { toConversationListItemDto, type ConversationListItemDto } from '@application/dto/messaging';
import { computeStatusTransition } from './conversationStatusTransition';

const VALID_STATUSES = ['open', 'resolved', 'pending'] as const;
type ConversationStatus = (typeof VALID_STATUSES)[number];

function isValidStatus(status: string): status is ConversationStatus {
  return (VALID_STATUSES as readonly string[]).includes(status);
}

/**
 * SetConversationStatus (messaging-inbox-productivity, F1.5 fase C, STATUS-1) —
 * resolver/reabrir/marcar-pendiente una conversación desde el inbox, gateado
 * por el MISMO permiso que `SendMessage` (`messaging:send`).
 *
 * `status` y `canReply` son INDEPENDIENTES: esta use case JAMÁS toca `canReply`
 * ni recalcula la ventana de 24h — resolver/reabrir no reabre la ventana de
 * respuesta de WhatsApp (esa es una regla de Meta sobre el ÚLTIMO inbound, no
 * sobre el estado administrativo de la conversación en Chatwoot).
 *
 * Guard order (mismo criterio "cutting at the first failure" que `SendMessage`):
 *   1. Validar `status ∈ {open,resolved,pending}` → `InvalidConversationStatusError`
 *      (400, código `VALIDATION_ERROR`) SIN tocar el repo ni Chatwoot.
 *   2. `conversationRepo.findById` → `ConversationNotFoundError` (404).
 *   3. `gateway.setStatus` → cualquier falla → `ChatwootUnavailableError` (503),
 *      mismo criterio SEND-3 que `SendMessage.execute`.
 *   4. Upsert POST-OK del mirror actualizando ÚNICAMENTE `status` — a diferencia
 *      de `SendMessage`'s SEND-5 (línea 209-218), esto NUNCA bumpea
 *      `lastMessagePreview`/`lastMessageAt`: cambiar el estado no reordena la
 *      lista del inbox (ese orden depende solo de la actividad de mensajes).
 */
export class SetConversationStatus {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly gateway: ChatwootGateway,
    /**
     * conversation-events (Ola 2) — registro BEST-EFFORT de la transición resolved/reopened.
     * Opcional: los call-sites/tests de F1.5 que lo construyen con 2 args siguen compilando
     * (mismo criterio que los deps opcionales de `ReceiveChatwootWebhook`). Sin él, sólo se
     * pierde el evento (resolvedAt/firstResolvedAt SIEMPRE se escriben, van en el upsert).
     */
    private readonly eventRepo?: ConversationEventRepository,
  ) {}

  /**
   * @param actorId usuario RBAC que dispara el cambio (req.user.id). Ausente → evento con
   *   actorId null (no debería pasar desde la route autenticada, degrada seguro).
   */
  async execute(conversationId: string, status: string, actorId?: string | null): Promise<ConversationListItemDto> {
    if (!isValidStatus(status)) {
      throw new InvalidConversationStatusError(status);
    }

    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    // messaging-bulk-inbox (F1) — una conversación origin:'bulk' aún no adoptada por
    // Chatwoot no tiene contraparte donde setear estado (edge case). Narrowing a number.
    const chatwootConversationId = conversation.chatwootConversationId;
    if (chatwootConversationId === null) throw new ConversationNotFoundError(conversationId);

    try {
      await this.gateway.setStatus(chatwootConversationId, status);
    } catch {
      throw new ChatwootUnavailableError();
    }

    // conversation-events (Ola 2) — timestamps derivados del ciclo de resolución, escritos
    // ATÓMICAMENTE junto al status (NO best-effort: si el upsert falla, la operación falla,
    // como hoy). El evento (abajo) sí es best-effort.
    const transition = computeStatusTransition(
      conversation.status,
      status,
      conversation.firstResolvedAt,
      new Date().toISOString(),
    );

    const updated = await this.conversationRepo.upsertByChatwootId({
      chatwootConversationId,
      status,
      ...transition.patch,
    });

    // conversation-events (Ola 2) — best-effort estilo el sync de lastPublicMessageDirection:
    // un fallo al registrar el evento NUNCA tumba el cambio de estado (que ya cruzó a Chatwoot
    // y ya se persistió en el mirror). Sólo se emite en una transición REAL (resolved/reopened).
    if (transition.event && this.eventRepo) {
      try {
        await this.eventRepo.record({
          conversationId,
          type: transition.event.type,
          actorId: actorId ?? null,
          fromValue: transition.event.fromValue,
          toValue: transition.event.toValue,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[messaging] registro de ConversationEvent (status) falló (best-effort, la operación ya se persistió)', {
          conversationId,
          type: transition.event.type,
          error: err instanceof Error ? err.message : err,
        });
      }
    }

    return toConversationListItemDto(updated);
  }
}
