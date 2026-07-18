import { ConversationLabel } from '../entities/conversation-label';

/**
 * conversation-labels (Ola 5) — CATÁLOGO de etiquetas de conversación. Calco de
 * `TicketAreaCatalogRepository` salvo por `countInUse`: borrar una label la quita
 * de todas las conversaciones (onDelete Cascade en la join), así que no hay guard
 * de "en uso" (comportamiento de tag). `findByIds` valida en bloque el set de
 * `SetConversationLabels` sin un getById por id (anti-N+1).
 */
export interface ConversationLabelRepository {
  list(): Promise<ConversationLabel[]>;
  getById(id: string): Promise<ConversationLabel | null>;
  getByName(name: string): Promise<ConversationLabel | null>;
  /** Devuelve SOLO las labels existentes del set `ids` (para validar el set de asignación). */
  findByIds(ids: string[]): Promise<ConversationLabel[]>;
  create(data: { name: string; color: string }): Promise<ConversationLabel>;
  update(id: string, data: Partial<{ name: string; color: string }>): Promise<ConversationLabel | null>;
  delete(id: string): Promise<boolean>;
}
