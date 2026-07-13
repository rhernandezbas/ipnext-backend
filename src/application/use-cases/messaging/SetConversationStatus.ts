import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ChatwootGateway } from '@domain/ports/ChatwootGateway';
import {
  ConversationNotFoundError,
  ChatwootUnavailableError,
  InvalidConversationStatusError,
} from '@domain/errors/messaging';
import { toConversationListItemDto, type ConversationListItemDto } from '@application/dto/messaging';

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
  ) {}

  async execute(conversationId: string, status: string): Promise<ConversationListItemDto> {
    if (!isValidStatus(status)) {
      throw new InvalidConversationStatusError(status);
    }

    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    try {
      await this.gateway.setStatus(conversation.chatwootConversationId, status);
    } catch {
      throw new ChatwootUnavailableError();
    }

    const updated = await this.conversationRepo.upsertByChatwootId({
      chatwootConversationId: conversation.chatwootConversationId,
      status,
    });

    return toConversationListItemDto(updated);
  }
}
