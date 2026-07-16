import { NewsPostRepository, UpdateNewsPostData } from '@domain/ports/NewsPostRepository';
import { NewsCategoryRepository } from '@domain/ports/NewsCategoryRepository';
import { NewsPostNotFoundError, NewsCategoryNotFoundError } from '@domain/errors/news';
import { NewsPostDto, toNewsPostDto } from '@application/dto/news.dto';

export class UpdateNewsPost {
  constructor(
    private readonly postRepo: NewsPostRepository,
    private readonly categoryRepo: NewsCategoryRepository,
  ) {}

  async execute(id: string, patch: UpdateNewsPostData): Promise<NewsPostDto> {
    if (patch.categoryId !== undefined) {
      const category = await this.categoryRepo.findById(patch.categoryId);
      if (!category) throw new NewsCategoryNotFoundError(patch.categoryId);
    }

    const updated = await this.postRepo.update(id, patch);
    if (!updated) throw new NewsPostNotFoundError(id);
    return toNewsPostDto(updated, false);
  }
}
