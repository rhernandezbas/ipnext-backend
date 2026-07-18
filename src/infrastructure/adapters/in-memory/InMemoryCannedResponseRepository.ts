import { randomUUID } from 'crypto';
import { CannedResponse } from '@domain/entities/cannedResponse';
import { CannedResponseListQuery, CannedResponseRepository } from '@domain/ports/CannedResponseRepository';

/**
 * Ola 4 (inbox-Chatwoot) — port in-memory de las respuestas rápidas (tests de use case
 * y de rutas). Paridad con PrismaCannedResponseRepository: list ordena por shortcut ASC
 * y `q` filtra por substring case-insensitive en shortcut O content.
 */
export class InMemoryCannedResponseRepository implements CannedResponseRepository {
  private items: CannedResponse[] = [];

  async list(query?: CannedResponseListQuery): Promise<CannedResponse[]> {
    let result = [...this.items];
    const q = query?.q?.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (i) => i.shortcut.toLowerCase().includes(q) || i.content.toLowerCase().includes(q),
      );
    }
    return result.sort((a, b) => a.shortcut.localeCompare(b.shortcut)).map((i) => ({ ...i }));
  }

  async findById(id: string): Promise<CannedResponse | null> {
    const item = this.items.find((i) => i.id === id);
    return item ? { ...item } : null;
  }

  async findByShortcut(shortcut: string): Promise<CannedResponse | null> {
    const item = this.items.find((i) => i.shortcut.toLowerCase() === shortcut.toLowerCase());
    return item ? { ...item } : null;
  }

  async create(input: { shortcut: string; content: string; createdById: string | null }): Promise<CannedResponse> {
    const now = new Date();
    const item: CannedResponse = {
      id: randomUUID(),
      shortcut: input.shortcut,
      content: input.content,
      createdById: input.createdById,
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, patch: { shortcut?: string; content?: string }): Promise<CannedResponse | null> {
    const index = this.items.findIndex((i) => i.id === id);
    if (index === -1) return null;
    const current = this.items[index]!;
    const updated: CannedResponse = {
      ...current,
      ...(patch.shortcut !== undefined ? { shortcut: patch.shortcut } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      updatedAt: new Date(),
    };
    this.items[index] = updated;
    return { ...updated };
  }

  async delete(id: string): Promise<void> {
    const index = this.items.findIndex((i) => i.id === id);
    if (index === -1) return;
    this.items.splice(index, 1);
  }
}
