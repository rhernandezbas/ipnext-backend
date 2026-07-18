import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ChatwootGateway } from '@domain/ports/ChatwootGateway';
import type { ConversationEventRepository } from '@domain/ports/ConversationEventRepository';
import {
  ConversationNotFoundError,
  ChatwootUnavailableError,
  InvalidSnoozeUntilError,
} from '@domain/errors/messaging';
import { toConversationListItemDto, type ConversationListItemDto } from '@application/dto/messaging';

/**
 * SnoozeConversation (conversation-snooze, Ola 6c) — posponer ("snooze") una conversación
 * hasta un timestamp FUTURO: desaparece de Abiertas/Sin atender y reaparece sola cuando el
 * `snoozedUntil` vence (derivación lazy en los buckets — ver `buildConversationWhere`/
 * `applyFilters` — más el watcher opcional `ReactivateExpiredSnoozes` que normaliza el status).
 *
 * Gateado por el MISMO permiso que `SendMessage` (`messaging:send`) — no hay uno separado.
 * `snoozedUntil` es INDEPENDIENTE de `canReply` (la ventana de 24h de WhatsApp): esta use case
 * JAMÁS toca `canReply` ni recalcula la ventana.
 *
 * Guard order (mismo criterio "cutting at the first failure" que `SetConversationStatus`):
 *   1. Validar `snoozedUntil` = ISO parseable Y estrictamente FUTURO → `InvalidSnoozeUntilError`
 *      (400) SIN tocar el repo ni Chatwoot.
 *   2. `conversationRepo.findById` → `ConversationNotFoundError` (404); `chatwootConversationId`
 *      null (bulk no adoptada) → 404 (no hay contraparte en Chatwoot que posponer).
 *   3. `gateway.setStatus(cwId, 'snoozed', snoozedUntil)` → cualquier falla → `ChatwootUnavailableError`
 *      (503), mismo criterio SEND-3 que `SendMessage`.
 *   4. Upsert POST-OK del mirror: `status='snoozed'` + `snoozedUntil`. NUNCA bumpea
 *      `lastMessagePreview`/`lastMessageAt` (posponer no reordena la lista) ni toca `canReply`.
 *   5. Evento `ConversationEvent` tipo 'snoozed' — BEST-EFFORT (un fallo al registrarlo NO tumba
 *      el snooze, que ya cruzó a Chatwoot y ya se persistió), mismo molde que `SetConversationStatus`.
 */
export class SnoozeConversation {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly gateway: ChatwootGateway,
    /**
     * conversation-events (Ola 2) — registro BEST-EFFORT del evento 'snoozed'. Opcional: los
     * call-sites/tests que lo construyen con 2 args siguen compilando (mismo criterio que
     * `SetConversationStatus`). Sin él, sólo se pierde el evento (el snooze SIEMPRE se persiste).
     */
    private readonly eventRepo?: ConversationEventRepository,
  ) {}

  /**
   * @param snoozedUntil ISO-8601 futuro (validado acá; el route además valida el formato con Zod).
   * @param actorId usuario RBAC que dispara el snooze (req.user.id), para atribuir el evento.
   */
  async execute(
    conversationId: string,
    snoozedUntil: string,
    actorId?: string | null,
  ): Promise<ConversationListItemDto> {
    const ts = Date.parse(snoozedUntil);
    if (Number.isNaN(ts) || ts <= Date.now()) {
      throw new InvalidSnoozeUntilError(snoozedUntil);
    }

    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    const chatwootConversationId = conversation.chatwootConversationId;
    if (chatwootConversationId === null) throw new ConversationNotFoundError(conversationId);

    try {
      await this.gateway.setStatus(chatwootConversationId, 'snoozed', snoozedUntil);
    } catch {
      throw new ChatwootUnavailableError();
    }

    const updated = await this.conversationRepo.upsertByChatwootId({
      chatwootConversationId,
      status: 'snoozed',
      snoozedUntil,
    });

    if (this.eventRepo) {
      try {
        await this.eventRepo.record({
          conversationId,
          type: 'snoozed',
          actorId: actorId ?? null,
          fromValue: conversation.status,
          toValue: 'snoozed',
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[messaging] registro de ConversationEvent (snoozed) falló (best-effort, la operación ya se persistió)', {
          conversationId,
          error: err instanceof Error ? err.message : err,
        });
      }
    }

    return toConversationListItemDto(updated);
  }
}
