import type { ConversationLabelRepository } from '@domain/ports/ConversationLabelRepository';
import type { ConversationLabel } from '@domain/entities/conversation-label';
import { ConversationLabelNameConflictError } from '@domain/errors/messaging';

/**
 * conversation-labels (Ola 5) — crea una etiqueta del catálogo. Gate `messaging:manage`.
 * Conflicto de nombre case-insensitive (mismo criterio que `CreateTicketArea`,
 * apoyado en `getByName`).
 */
export class CreateLabel {
  constructor(private readonly repo: ConversationLabelRepository) {}
  async execute(data: { name: string; color: string }): Promise<ConversationLabel> {
    const existing = await this.repo.getByName(data.name);
    if (existing) throw new ConversationLabelNameConflictError(data.name);
    return this.repo.create(data);
  }
}
