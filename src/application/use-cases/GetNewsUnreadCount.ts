import { NewsPostRepository } from '@domain/ports/NewsPostRepository';

/** The cheap badge endpoint's use case — a single COUNT (design §7). */
export class GetNewsUnreadCount {
  constructor(private readonly postRepo: NewsPostRepository) {}

  async execute(userId: string): Promise<number> {
    return this.postRepo.countUnread(userId);
  }
}
