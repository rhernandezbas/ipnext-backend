import { NewsCategoryRepository } from '@domain/ports/NewsCategoryRepository';
import { NewsCategoryDto, toNewsCategoryDto } from '@application/dto/news.dto';

export class ListNewsCategories {
  constructor(private readonly repo: NewsCategoryRepository) {}

  async execute(): Promise<NewsCategoryDto[]> {
    const categories = await this.repo.list();
    return categories.map(toNewsCategoryDto);
  }
}
