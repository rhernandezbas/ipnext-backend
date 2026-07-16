import { NewsPostRepository, NewsPostListFilters } from '@domain/ports/NewsPostRepository';
import { ListNewsPostsResultDto, toNewsPostDto } from '@application/dto/news.dto';

export class ListNewsPosts {
  constructor(private readonly postRepo: NewsPostRepository) {}

  async execute(filters: NewsPostListFilters, userId: string): Promise<ListNewsPostsResultDto> {
    const [items, unreadCount] = await Promise.all([
      this.postRepo.list(filters, userId),
      // NEWS-UC-2: unreadCount is GLOBAL — independent of any category filter applied to items.
      this.postRepo.countUnread(userId),
    ]);
    return {
      items: items.map((item) => toNewsPostDto(item, item.read)),
      unreadCount,
    };
  }
}
