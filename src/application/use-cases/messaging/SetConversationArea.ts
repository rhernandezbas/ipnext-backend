import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import type { ConversationEventRepository } from '@domain/ports/ConversationEventRepository';
import { ConversationNotFoundError } from '@domain/errors/messaging';
import { TicketAreaNotFoundError } from '@domain/errors/tickets';
import { toConversationListItemDto, type ConversationListItemDto } from '@application/dto/messaging';

/**
 * SetConversationArea (F1.5-C2, asignación) — setea/limpia el área
 * (`TicketAreaCatalog`) de una conversación del inbox. `areaId` es un campo
 * EXCLUSIVAMENTE LOCAL del mirror — nunca se sincroniza a Chatwoot. Clon 1:1
 * del patrón `Ticket.areaId`.
 *
 * Reusa `TicketAreaCatalogRepository` directamente (mismo puerto que
 * `ListTicketAreas`/`CreateTicketArea`) en vez de un lookup nuevo — el catálogo
 * de áreas ya es un puerto de dominio legítimo, sin acoplar esta use case a
 * infraestructura.
 *
 * Guard order (idéntico a `AssignConversation`):
 *   1. `conversationRepo.findById` → `ConversationNotFoundError` (404) — MISMO
 *      error que `SetConversationStatus`/`AssignConversation`.
 *   2. Si `areaId !== null` → `areaRepo.getById` → si no existe,
 *      `TicketAreaNotFoundError` (reusa el error existente del módulo de
 *      tickets — mismo criterio "reusar el error del dueño real del recurso"
 *      que `AssignConversation` reusa `UserNotFoundError`).
 *      `areaId === null` (limpiar área) SALTA el lookup por completo.
 *   3. `conversationRepo.updateLocalFields` — actualiza ÚNICAMENTE `areaId`
 *      (nunca status/canReply/lastMessagePreview/lastMessageAt/assigneeId).
 */
export class SetConversationArea {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly areaRepo: TicketAreaCatalogRepository,
    /**
     * conversation-events (Ola 2) — registro BEST-EFFORT del evento 'area_changed'.
     * Opcional (call-sites/tests de F1.5-C2 con 2 args siguen compilando).
     */
    private readonly eventRepo?: ConversationEventRepository,
  ) {}

  /** @param actorId usuario RBAC que cambia el área (req.user.id). */
  async execute(
    conversationId: string,
    areaId: string | null,
    actorId?: string | null,
  ): Promise<ConversationListItemDto> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    if (areaId !== null) {
      const area = await this.areaRepo.getById(areaId);
      if (!area) throw new TicketAreaNotFoundError(areaId);
    }

    const previousAreaId = conversation.areaId;
    const updated = await this.conversationRepo.updateLocalFields(conversationId, { areaId });

    // conversation-events (Ola 2) — 'area_changed' en un cambio REAL (viejo != nuevo), incluso
    // al limpiar el área (to=null). Best-effort (un fallo del evento no tumba el cambio, que ya
    // se persistió). from/to = área vieja→nueva.
    if (this.eventRepo && previousAreaId !== areaId) {
      try {
        await this.eventRepo.record({
          conversationId,
          type: 'area_changed',
          actorId: actorId ?? null,
          fromValue: previousAreaId,
          toValue: areaId,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[messaging] registro de ConversationEvent (area) falló (best-effort, el cambio ya se persistió)', {
          conversationId,
          error: err instanceof Error ? err.message : err,
        });
      }
    }

    // Existence was just confirmed above — updateLocalFields returning null here
    // would only mean a TOCTOU race, unreachable in this codebase's test/prod paths.
    return toConversationListItemDto(updated!);
  }
}
