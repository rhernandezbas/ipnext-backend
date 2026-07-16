import { prisma } from '../../database/prisma';
import type { NewsCategory } from '@domain/entities/news';
import type { NewsCategoryRepository } from '@domain/ports/NewsCategoryRepository';

function toEntity(row: { id: string; name: string; color: string }): NewsCategory {
  return { id: row.id, name: row.name, color: row.color };
}

export class PrismaNewsCategoryRepository implements NewsCategoryRepository {
  async list(): Promise<NewsCategory[]> {
    const rows = await prisma.newsCategory.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toEntity);
  }

  async findById(id: string): Promise<NewsCategory | null> {
    const row = await prisma.newsCategory.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async findByName(name: string): Promise<NewsCategory | null> {
    const row = await prisma.newsCategory.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    return row ? toEntity(row) : null;
  }

  async create(data: { name: string; color: string }): Promise<NewsCategory> {
    const row = await prisma.newsCategory.create({ data });
    return toEntity(row);
  }

  async update(id: string, data: Partial<{ name: string; color: string }>): Promise<NewsCategory | null> {
    try {
      const row = await prisma.newsCategory.update({ where: { id }, data });
      return toEntity(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await prisma.newsCategory.delete({ where: { id } });
    } catch {
      // Missing id — DeleteNewsCategory use case already 404s before calling delete;
      // swallow here so the port stays a no-op on a already-gone row (mirrors
      // PrismaTicketAreaCatalogRepository.delete's try/catch-return shape).
    }
  }

  async countPosts(id: string): Promise<number> {
    return prisma.newsPost.count({ where: { categoryId: id } });
  }
}
