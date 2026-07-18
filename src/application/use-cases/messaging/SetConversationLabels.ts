import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ConversationLabelRepository } from '@domain/ports/ConversationLabelRepository';
import { ConversationNotFoundError, ConversationLabelNotFoundError } from '@domain/errors/messaging';
import { toConversationListItemDto, type ConversationListItemDto } from '@application/dto/messaging';

/**
 * conversation-labels (Ola 5) — REEMPLAZA el set completo de labels de una
 * conversación por `labelIds` (no acumula; `[]` limpia todas). LOCAL-only, sin
 * llamada a Chatwoot. Gate `messaging:send` (misma capacidad que asignar área/
 * agente — ver la ruta).
 *
 * Guard order (molde de `SetConversationArea`):
 *   1. `conversationRepo.findById` → `ConversationNotFoundError` (404).
 *   2. Dedup de `labelIds`; si queda alguno, `labelRepo.findByIds` y se compara el
 *      count: si CUALQUIER id no existe → `ConversationLabelNotFoundError` (404).
 *      La operación es ATÓMICA (no ignora ids desconocidos — el FE trabaja contra
 *      un catálogo, un id ausente es un bug a exponer, no a tragar en silencio).
 *   3. `conversationRepo.setLabels` — reemplaza el set. Ningún otro campo se toca.
 */
export class SetConversationLabels {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly labelRepo: ConversationLabelRepository,
  ) {}

  async execute(conversationId: string, labelIds: string[]): Promise<ConversationListItemDto> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    const uniqueIds = Array.from(new Set(labelIds));
    if (uniqueIds.length > 0) {
      const found = await this.labelRepo.findByIds(uniqueIds);
      if (found.length !== uniqueIds.length) {
        const foundIds = new Set(found.map((l) => l.id));
        const missing = uniqueIds.find((id) => !foundIds.has(id))!;
        throw new ConversationLabelNotFoundError(missing);
      }
    }

    const updated = await this.conversationRepo.setLabels(conversationId, uniqueIds);
    // Existence was confirmed above — a null here would only be a TOCTOU race,
    // unreachable in this codebase's test/prod paths (same note as SetConversationArea).
    return toConversationListItemDto(updated!);
  }
}
