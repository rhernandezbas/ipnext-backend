import { NewsCategoryRepository } from '@domain/ports/NewsCategoryRepository';
import { NewsCategoryNotFoundError, NewsCategoryNameConflictError } from '@domain/errors/news';
import { NewsCategoryDto, toNewsCategoryDto } from '@application/dto/news.dto';

export class UpdateNewsCategory {
  constructor(private readonly repo: NewsCategoryRepository) {}

  async execute(id: string, data: { name?: string; color?: string }): Promise<NewsCategoryDto> {
    const item = await this.repo.findById(id);
    if (!item) throw new NewsCategoryNotFoundError(id);

    if (data.name && data.name.toLowerCase() !== item.name.toLowerCase()) {
      const conflict = await this.repo.findByName(data.name);
      if (conflict && conflict.id !== id) throw new NewsCategoryNameConflictError(data.name);
    }

    const updated = await this.repo.update(id, data);
    if (!updated) throw new NewsCategoryNotFoundError(id);
    return toNewsCategoryDto(updated);
  }
}
