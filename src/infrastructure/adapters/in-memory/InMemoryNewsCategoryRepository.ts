import { randomUUID } from 'crypto';
import { NewsCategory } from '@domain/entities/news';
import { NewsCategoryRepository } from '@domain/ports/NewsCategoryRepository';

/**
 * Minimal shape InMemoryNewsCategoryRepository needs from a paired post repository
 * to make `countPosts` count REAL posts (review fix M3) instead of the removed
 * `postCounts` hand-set seam. Deliberately NOT the full `NewsPostRepository` port —
 * this in-memory pairing mirrors PrismaNewsCategoryRepository.countPosts, which
 * COUNTs the `newsPost` table directly rather than going through NewsPostRepository.
 */
export interface PostCounter {
  countByCategoryId(categoryId: string): number;
}

export class InMemoryNewsCategoryRepository implements NewsCategoryRepository {
  private items: NewsCategory[] = [];

  /**
   * Wired post-construction via `attachPostRepo` — InMemoryNewsPostRepository's
   * constructor already takes a NewsCategoryRepository (for the M4 fresh-JOIN fix),
   * so THIS instance must exist before the paired post repo does; the reverse link
   * can only be set once both are built:
   *
   *   const categoryRepo = new InMemoryNewsCategoryRepository();
   *   const postRepo = new InMemoryNewsPostRepository(categoryRepo);
   *   categoryRepo.attachPostRepo(postRepo);
   *
   * Callers that never attach a post repo (isolated unit tests of this class alone)
   * get `countPosts` = 0 — no seam needed, no behavior surprise.
   */
  private postCounter: PostCounter | null = null;

  attachPostRepo(postRepo: PostCounter): void {
    this.postCounter = postRepo;
  }

  /** Ordered name ASC — parity with PrismaNewsCategoryRepository.list's `orderBy: { name: 'asc' }`. */
  async list(): Promise<NewsCategory[]> {
    return [...this.items].map((i) => ({ ...i })).sort((a, b) => a.name.localeCompare(b.name));
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
    return this.postCounter ? this.postCounter.countByCategoryId(id) : 0;
  }
}
