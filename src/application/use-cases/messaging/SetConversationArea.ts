import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
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
  ) {}

  async execute(conversationId: string, areaId: string | null): Promise<ConversationListItemDto> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    if (areaId !== null) {
      const area = await this.areaRepo.getById(areaId);
      if (!area) throw new TicketAreaNotFoundError(areaId);
    }

    const updated = await this.conversationRepo.updateLocalFields(conversationId, { areaId });
    // Existence was just confirmed above — updateLocalFields returning null here
    // would only mean a TOCTOU race, unreachable in this codebase's test/prod paths.
    return toConversationListItemDto(updated!);
  }
}
