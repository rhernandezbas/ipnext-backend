import type { ConversationLabelRepository } from '@domain/ports/ConversationLabelRepository';
import { ConversationLabelNotFoundError } from '@domain/errors/messaging';

/**
 * conversation-labels (Ola 5) — borra una etiqueta del catálogo. Gate `messaging:manage`.
 * A DIFERENCIA de `DeleteTicketArea` NO hay guard "en uso": borrar una label la
 * quita de todas las conversaciones (onDelete Cascade en la join
 * ConversationLabelAssignment) — comportamiento de tag. Solo valida existencia (404).
 */
export class DeleteLabel {
  constructor(private readonly repo: ConversationLabelRepository) {}
  async execute(id: string): Promise<void> {
    const item = await this.repo.getById(id);
    if (!item) throw new ConversationLabelNotFoundError(id);
    await this.repo.delete(id);
  }
}
