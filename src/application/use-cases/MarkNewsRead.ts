import { NewsPostRepository } from '@domain/ports/NewsPostRepository';
import { NewsPostNotFoundError } from '@domain/errors/news';

/**
 * Idempotent — repo.markRead is an upsert, but existence is checked here
 * (findById) since the repository's markRead does not validate the post exists;
 * the route needs 404 for an unknown post id (spec NEWS-HTTP-1).
 */
export class MarkNewsRead {
  constructor(private readonly postRepo: NewsPostRepository) {}

  async execute(postId: string, userId: string): Promise<void> {
    const post = await this.postRepo.findById(postId, userId);
    if (!post) throw new NewsPostNotFoundError(postId);
    await this.postRepo.markRead(postId, userId);
  }
}
