import type { ConversationLabelRepository } from '@domain/ports/ConversationLabelRepository';
import type { ConversationLabel } from '@domain/entities/conversation-label';

/**
 * conversation-labels (Ola 5) — catálogo de etiquetas para el picker del inbox y el
 * CRUD. Gate `messaging:read` (leer el catálogo no habilita mutarlo). Clon de
 * `ListTicketAreas`.
 */
export class ListLabels {
  constructor(private readonly repo: ConversationLabelRepository) {}
  async execute(): Promise<ConversationLabel[]> {
    return this.repo.list();
  }
}
