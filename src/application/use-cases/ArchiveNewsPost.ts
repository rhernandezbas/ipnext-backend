import { NewsPostRepository } from '@domain/ports/NewsPostRepository';
import { NewsPostNotFoundError } from '@domain/errors/news';
import { NewsPostDto, toNewsPostDto } from '@application/dto/news.dto';

/** NEWS-UC-3 — sets archivedAt=now with `true`, clears it (null) with `false`. */
export class ArchiveNewsPost {
  constructor(private readonly postRepo: NewsPostRepository) {}

  async execute(id: string, archived: boolean): Promise<NewsPostDto> {
    const updated = await this.postRepo.setArchived(id, archived);
    if (!updated) throw new NewsPostNotFoundError(id);
    return toNewsPostDto(updated, false);
  }
}
