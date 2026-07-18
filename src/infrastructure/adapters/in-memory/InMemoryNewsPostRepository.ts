import { randomUUID } from 'crypto';
import { NewsPost, NewsPostWithReadState, NewsCategory } from '@domain/entities/news';
import {
  NewsPostRepository,
  NewsPostListFilters,
  CreateNewsPostData,
  UpdateNewsPostData,
} from '@domain/ports/NewsPostRepository';
import { NewsCategoryRepository } from '@domain/ports/NewsCategoryRepository';
import { InMemoryNewsCategoryRepository } from './InMemoryNewsCategoryRepository';

/**
 * Returned when a post references a categoryId the injected NewsCategoryRepository
 * doesn't know about. Repositories don't validate FKs (that's the use case's job —
 * CreateNewsPost/UpdateNewsPost throw NewsCategoryNotFoundError up-front); this is
 * just a safe embed so `category` is never undefined on the entity.
 */
const FALLBACK_CATEGORY_NAME = '(sin categoría)';
const FALLBACK_CATEGORY_COLOR = '#94a3b8';

export class InMemoryNewsPostRepository implements NewsPostRepository {
  private items: NewsPost[] = [];
  /** Test seam + idempotency backbone: keyed by `${postId}|${userId}`. */
  public receipts: Map<string, { postId: string; userId: string; readAt: Date }> = new Map();

  /**
   * `category` is JOIN-derived (design §5.4 — NewsPostDto nests the category).
   * Prisma resolves this via `include: { category: true }` on EVERY query — so
   * `findById`/`list` re-resolve it fresh on every read too (review fix M4), instead
   * of trusting the create-time snapshot stored on `items`. Defaults to a private,
   * empty NewsCategoryRepository for isolated unit tests that don't care about the
   * embedded category shape.
   */
  constructor(private readonly categoryRepo: NewsCategoryRepository = new InMemoryNewsCategoryRepository()) {}

  private async resolveCategory(categoryId: string): Promise<NewsCategory> {
    const cat = await this.categoryRepo.findById(categoryId);
    return cat ?? { id: categoryId, name: FALLBACK_CATEGORY_NAME, color: FALLBACK_CATEGORY_COLOR };
  }

  private key(postId: string, userId: string): string {
    return `${postId}|${userId}`;
  }

  async create(input: CreateNewsPostData): Promise<NewsPost> {
    const now = new Date();
    const post: NewsPost = {
      id: randomUUID(),
      title: input.title,
      body: input.body,
      categoryId: input.categoryId,
      category: await this.resolveCategory(input.categoryId),
      authorId: input.authorId,
      authorName: input.authorName,
      pinned: input.pinned ?? false,
      publishedAt: now,
      archivedAt: null,
      lastBroadcastAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(post);
    return { ...post };
  }

  async update(id: string, patch: UpdateNewsPostData): Promise<NewsPost | null> {
    const index = this.items.findIndex((i) => i.id === id);
    if (index === -1) return null;
    const current = this.items[index]!;
    const category =
      patch.categoryId && patch.categoryId !== current.categoryId
        ? await this.resolveCategory(patch.categoryId)
        : current.category;
    const updated: NewsPost = {
      ...current,
      ...patch,
      category,
      updatedAt: new Date(),
    };
    this.items[index] = updated;
    return { ...updated };
  }

  async findById(id: string, userId: string): Promise<NewsPostWithReadState | null> {
    const item = this.items.find((i) => i.id === id);
    if (!item) return null;
    // Fresh JOIN on every read (review fix M4) — not the create-time snapshot.
    const category = await this.resolveCategory(item.categoryId);
    return { ...item, category, read: this.receipts.has(this.key(id, userId)) };
  }

  async list(filters: NewsPostListFilters, userId: string): Promise<NewsPostWithReadState[]> {
    const wantArchived = filters.archived === true;
    let result = this.items.filter((i) => (wantArchived ? i.archivedAt !== null : i.archivedAt === null));
    if (filters.categoryId) {
      result = result.filter((i) => i.categoryId === filters.categoryId);
    }
    // Fresh JOIN on every read (review fix M4) — not the create-time snapshot.
    const withRead: NewsPostWithReadState[] = await Promise.all(
      result.map(async (i) => ({
        ...i,
        category: await this.resolveCategory(i.categoryId),
        read: this.receipts.has(this.key(i.id, userId)),
      })),
    );
    // pinned DESC, publishedAt DESC
    return withRead.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.publishedAt.getTime() - a.publishedAt.getTime();
    });
  }

  async setArchived(id: string, archived: boolean): Promise<NewsPost | null> {
    const index = this.items.findIndex((i) => i.id === id);
    if (index === -1) return null;
    const updated: NewsPost = {
      ...this.items[index]!,
      archivedAt: archived ? new Date() : null,
      updatedAt: new Date(),
    };
    this.items[index] = updated;
    return { ...updated };
  }

  async markRead(postId: string, userId: string): Promise<void> {
    // Map.set on an existing key overwrites in place — dedup is structural, not a check.
    this.receipts.set(this.key(postId, userId), { postId, userId, readAt: new Date() });
  }

  async countUnread(userId: string): Promise<number> {
    return this.items.filter(
      (i) => i.archivedAt === null && !this.receipts.has(this.key(i.id, userId)),
    ).length;
  }

  async recordBroadcast(id: string): Promise<void> {
    const index = this.items.findIndex((i) => i.id === id);
    if (index === -1) return; // no-op si el post ya no existe (contrato del port)
    this.items[index] = { ...this.items[index]!, lastBroadcastAt: new Date() };
  }

  /**
   * Synchronous raw count for InMemoryNewsCategoryRepository.countPosts (review fix
   * M3, implements the `PostCounter` shape) — mirrors PrismaNewsCategoryRepository
   * .countPosts, which COUNTs the newsPost table directly (archived or not) rather
   * than going through NewsPostRepository.
   */
  countByCategoryId(categoryId: string): number {
    return this.items.filter((i) => i.categoryId === categoryId).length;
  }
}
