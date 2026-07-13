import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { EntityLookup } from '@domain/ports/EntityLookup';
import { ConversationNotFoundError } from '@domain/errors/messaging';
import { UserNotFoundError } from '@domain/errors/rbacUser.errors';
import { toConversationListItemDto, type ConversationListItemDto } from '@application/dto/messaging';

/**
 * AssignConversation (F1.5-C2, asignación) — asigna/desasigna un agente
 * (RbacUser) a una conversación del inbox. `assigneeId` es un campo
 * EXCLUSIVAMENTE LOCAL del mirror: a diferencia de `SetConversationStatus`,
 * esta use case NUNCA llama al gateway de Chatwoot — Chatwoot no se entera de
 * quién lleva la conversación. Clon 1:1 del patrón `Ticket.assigneeId`.
 *
 * Guard order:
 *   1. `conversationRepo.findById` → `ConversationNotFoundError` (404) — MISMO
 *      error que `SetConversationStatus`. Corre ANTES del lookup de usuario:
 *      una conversación fantasma nunca debe gastar una llamada al lookup.
 *   2. Si `assigneeId !== null` → `assigneeLookup.findById` → si no existe,
 *      `UserNotFoundError` (404, reusa el código ya establecido por el módulo
 *      RbacUser — mismo criterio "reusar el error existente del dueño real del
 *      recurso" que `SetConversationArea` reusa `TicketAreaNotFoundError`).
 *      `assigneeId === null` (desasignar) SALTA el lookup por completo.
 *   3. `conversationRepo.updateLocalFields` — actualiza ÚNICAMENTE `assigneeId`
 *      (nunca status/canReply/lastMessagePreview/lastMessageAt/areaId).
 */
export class AssignConversation {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly assigneeLookup: EntityLookup,
  ) {}

  async execute(conversationId: string, assigneeId: string | null): Promise<ConversationListItemDto> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    if (assigneeId !== null) {
      const user = await this.assigneeLookup.findById(assigneeId);
      if (!user) throw new UserNotFoundError(assigneeId);
    }

    const updated = await this.conversationRepo.updateLocalFields(conversationId, { assigneeId });
    // updateLocalFields returns null only on a TOCTOU miss — existence was just
    // confirmed above, so this is unreachable in practice; the non-null assertion
    // keeps the return type honest without inventing a 2nd NotFoundError branch.
    return toConversationListItemDto(updated!);
  }
}
