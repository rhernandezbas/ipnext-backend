import { NewsPostRepository } from '@domain/ports/NewsPostRepository';
import { NewsCategoryRepository } from '@domain/ports/NewsCategoryRepository';
import { NewsCategoryNotFoundError } from '@domain/errors/news';
import { NewsPostDto, toNewsPostDto } from '@application/dto/news.dto';

export interface CreateNewsPostInput {
  title: string;
  body: string;
  categoryId: string;
  pinned?: boolean;
  /** Stamped from the session (req.user.id / req.user.username at the route). */
  authorId: string | null;
  authorName: string;
}

export class CreateNewsPost {
  constructor(
    private readonly postRepo: NewsPostRepository,
    private readonly categoryRepo: NewsCategoryRepository,
  ) {}

  async execute(input: CreateNewsPostInput): Promise<NewsPostDto> {
    const category = await this.categoryRepo.findById(input.categoryId);
    if (!category) throw new NewsCategoryNotFoundError(input.categoryId);

    const post = await this.postRepo.create({
      title: input.title,
      body: input.body,
      categoryId: input.categoryId,
      authorId: input.authorId,
      authorName: input.authorName,
      pinned: input.pinned,
    });
    // A freshly created post has no reader yet — read is always false here.
    return toNewsPostDto(post, false);
  }
}
