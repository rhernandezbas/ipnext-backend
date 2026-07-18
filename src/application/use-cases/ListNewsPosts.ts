import { NewsPostRepository, NewsPostListFilters } from '@domain/ports/NewsPostRepository';
import { NewsPostAttachmentRepository } from '@domain/ports/NewsPostAttachmentRepository';
import { ListNewsPostsResultDto, toNewsPostDto } from '@application/dto/news.dto';
import { toNewsPostAttachmentDto } from '@application/dto/newsAttachment.dto';

/** Reader batch de adjuntos (una query para toda la página). El repo full lo satisface. */
type NewsAttachmentBatchReader = Pick<NewsPostAttachmentRepository, 'findByNewsPostIds'>;

/**
 * N2: hydrates each item's attachments. Fetches ALL attachments for the page in ONE
 * batch call (`findByNewsPostIds`) and groups them in memory — no N+1.
 *
 * The attachment reader defaults to an empty null-object so pre-N2 call sites keep
 * compiling and return `attachments: []` on every item.
 */
export class ListNewsPosts {
  constructor(
    private readonly postRepo: NewsPostRepository,
    private readonly attachmentRepo: NewsAttachmentBatchReader = { async findByNewsPostIds() { return []; } },
  ) {}

  async execute(filters: NewsPostListFilters, userId: string): Promise<ListNewsPostsResultDto> {
    const [items, unreadCount] = await Promise.all([
      this.postRepo.list(filters, userId),
      // NEWS-UC-2: unreadCount is GLOBAL — independent of any category filter applied to items.
      this.postRepo.countUnread(userId),
    ]);

    const attachments = await this.attachmentRepo.findByNewsPostIds(items.map((i) => i.id));
    const byPost = new Map<string, ReturnType<typeof toNewsPostAttachmentDto>[]>();
    for (const a of attachments) {
      const list = byPost.get(a.newsPostId) ?? [];
      list.push(toNewsPostAttachmentDto(a));
      byPost.set(a.newsPostId, list);
    }

    return {
      items: items.map((item) => toNewsPostDto(item, item.read, byPost.get(item.id) ?? [])),
      unreadCount,
    };
  }
}
