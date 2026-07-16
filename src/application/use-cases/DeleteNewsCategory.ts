import { NewsCategoryRepository } from '@domain/ports/NewsCategoryRepository';
import { NewsCategoryNotFoundError, NewsCategoryInUseError } from '@domain/errors/news';

/** NEWS-UC-4 — guarded delete: refuses categories still referenced by posts. */
export class DeleteNewsCategory {
  constructor(private readonly repo: NewsCategoryRepository) {}

  async execute(id: string): Promise<void> {
    const item = await this.repo.findById(id);
    if (!item) throw new NewsCategoryNotFoundError(id);

    const count = await this.repo.countPosts(id);
    if (count > 0) throw new NewsCategoryInUseError(count);

    await this.repo.delete(id);
  }
}
