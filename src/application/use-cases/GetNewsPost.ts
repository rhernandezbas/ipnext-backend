import { NewsPostRepository } from '@domain/ports/NewsPostRepository';
import { NewsPostNotFoundError } from '@domain/errors/news';
import { NewsPostDto, toNewsPostDto } from '@application/dto/news.dto';

/** Detail lookup — does NOT mark the post as read (design §6.1: the mark is explicit via MarkNewsRead). */
export class GetNewsPost {
  constructor(private readonly postRepo: NewsPostRepository) {}

  async execute(id: string, userId: string): Promise<NewsPostDto> {
    const post = await this.postRepo.findById(id, userId);
    if (!post) throw new NewsPostNotFoundError(id);
    return toNewsPostDto(post, post.read);
  }
}
