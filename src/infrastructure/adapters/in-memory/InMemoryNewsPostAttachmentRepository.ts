import { NewsPostAttachmentRepository } from '@domain/ports/NewsPostAttachmentRepository';
import { NewsPostAttachment } from '@domain/entities/newsPostAttachment';

/**
 * Store in-memory de adjuntos de noticia (tests del port NewsPostAttachmentRepository).
 */
export class InMemoryNewsPostAttachmentRepository implements NewsPostAttachmentRepository {
  readonly store = new Map<string, NewsPostAttachment>();

  async create(attachment: NewsPostAttachment): Promise<NewsPostAttachment> {
    this.store.set(attachment.id, { ...attachment });
    return { ...attachment };
  }

  async findById(id: string): Promise<NewsPostAttachment | null> {
    const a = this.store.get(id);
    return a ? { ...a } : null;
  }

  async findByNewsPostId(newsPostId: string): Promise<NewsPostAttachment[]> {
    return Array.from(this.store.values())
      .filter((a) => a.newsPostId === newsPostId)
      .map((a) => ({ ...a }));
  }

  async findByNewsPostIds(newsPostIds: string[]): Promise<NewsPostAttachment[]> {
    const set = new Set(newsPostIds);
    return Array.from(this.store.values())
      .filter((a) => set.has(a.newsPostId))
      .map((a) => ({ ...a }));
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  async countByNewsPostId(newsPostId: string): Promise<number> {
    return Array.from(this.store.values()).filter((a) => a.newsPostId === newsPostId).length;
  }
}
