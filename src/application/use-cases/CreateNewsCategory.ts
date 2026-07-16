import { NewsCategoryRepository } from '@domain/ports/NewsCategoryRepository';
import { NewsCategoryNameConflictError } from '@domain/errors/news';
import { NewsCategoryDto, toNewsCategoryDto } from '@application/dto/news.dto';

export class CreateNewsCategory {
  constructor(private readonly repo: NewsCategoryRepository) {}

  async execute(data: { name: string; color: string }): Promise<NewsCategoryDto> {
    const existing = await this.repo.findByName(data.name);
    if (existing) throw new NewsCategoryNameConflictError(data.name);
    const created = await this.repo.create(data);
    return toNewsCategoryDto(created);
  }
}
