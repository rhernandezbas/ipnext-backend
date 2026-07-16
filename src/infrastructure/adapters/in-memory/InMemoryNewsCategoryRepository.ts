import { randomUUID } from 'crypto';
import { NewsCategory } from '@domain/entities/news';
import { NewsCategoryRepository } from '@domain/ports/NewsCategoryRepository';

export class InMemoryNewsCategoryRepository implements NewsCategoryRepository {
  private items: NewsCategory[] = [];
  /** Test seam: posts-per-category-id counts for the DeleteNewsCategory guard. */
  public postCounts: Record<string, number> = {};

  async list(): Promise<NewsCategory[]> {
    return [...this.items].map((i) => ({ ...i }));
  }

  async findById(id: string): Promise<NewsCategory | null> {
    const item = this.items.find((i) => i.id === id);
    return item ? { ...item } : null;
  }

  async findByName(name: string): Promise<NewsCategory | null> {
    const item = this.items.find((i) => i.name.toLowerCase() === name.toLowerCase());
    return item ? { ...item } : null;
  }

  async create(data: { name: string; color: string }): Promise<NewsCategory> {
    const item: NewsCategory = { id: randomUUID(), ...data };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, data: Partial<{ name: string; color: string }>): Promise<NewsCategory | null> {
    const index = this.items.findIndex((i) => i.id === id);
    if (index === -1) return null;
    this.items[index] = { ...this.items[index]!, ...data };
    return { ...this.items[index]! };
  }

  async delete(id: string): Promise<void> {
    const index = this.items.findIndex((i) => i.id === id);
    if (index === -1) return;
    this.items.splice(index, 1);
  }

  async countPosts(id: string): Promise<number> {
    return this.postCounts[id] ?? 0;
  }
}
