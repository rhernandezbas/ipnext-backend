import { randomUUID } from 'crypto';
import { ConversationLabel } from '@domain/entities/conversation-label';
import { ConversationLabelRepository } from '@domain/ports/ConversationLabelRepository';

/**
 * conversation-labels (Ola 5) — in-memory ConversationLabelRepository para tests de
 * use-case/route. Clon de `InMemoryTicketAreaCatalogRepository` (sin `ticketCounts`/
 * `countInUse`: borrar una label cascadea, no bloquea) + `findByIds`.
 */
export class InMemoryConversationLabelRepository implements ConversationLabelRepository {
  private items: ConversationLabel[] = [];

  async list(): Promise<ConversationLabel[]> {
    return [...this.items].map((i) => ({ ...i }));
  }

  async getById(id: string): Promise<ConversationLabel | null> {
    const item = this.items.find((i) => i.id === id);
    return item ? { ...item } : null;
  }

  async getByName(name: string): Promise<ConversationLabel | null> {
    const item = this.items.find((i) => i.name.toLowerCase() === name.toLowerCase());
    return item ? { ...item } : null;
  }

  async findByIds(ids: string[]): Promise<ConversationLabel[]> {
    const set = new Set(ids);
    return this.items.filter((i) => set.has(i.id)).map((i) => ({ ...i }));
  }

  async create(data: { name: string; color: string }): Promise<ConversationLabel> {
    const item: ConversationLabel = { id: randomUUID(), ...data };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, data: Partial<{ name: string; color: string }>): Promise<ConversationLabel | null> {
    const index = this.items.findIndex((i) => i.id === id);
    if (index === -1) return null;
    this.items[index] = { ...this.items[index]!, ...data };
    return { ...this.items[index]! };
  }

  async delete(id: string): Promise<boolean> {
    const index = this.items.findIndex((i) => i.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }
}
