import type { ConversationLabelRepository } from '@domain/ports/ConversationLabelRepository';
import type { ConversationLabel } from '@domain/entities/conversation-label';
import {
  ConversationLabelNotFoundError,
  ConversationLabelNameConflictError,
} from '@domain/errors/messaging';

/**
 * conversation-labels (Ola 5) — actualiza name/color de una etiqueta. Gate
 * `messaging:manage`. Clon de `UpdateTicketArea`: valida existencia (404) y, si
 * cambia el name a uno distinto (case-insensitive), conflicto (409).
 */
export class UpdateLabel {
  constructor(private readonly repo: ConversationLabelRepository) {}
  async execute(id: string, data: { name?: string; color?: string }): Promise<ConversationLabel> {
    const item = await this.repo.getById(id);
    if (!item) throw new ConversationLabelNotFoundError(id);

    if (data.name && data.name.toLowerCase() !== item.name.toLowerCase()) {
      const conflict = await this.repo.getByName(data.name);
      if (conflict && conflict.id !== id) throw new ConversationLabelNameConflictError(data.name);
    }

    const updated = await this.repo.update(id, data);
    if (!updated) throw new ConversationLabelNotFoundError(id);
    return updated;
  }
}
