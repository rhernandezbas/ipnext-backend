import { prisma } from '../../database/prisma';
import type { NewsCategory } from '@domain/entities/news';
import type { NewsCategoryRepository } from '@domain/ports/NewsCategoryRepository';
import { NewsCategoryNameConflictError, NewsCategoryInUseError } from '@domain/errors/news';

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
    try {
      const row = await prisma.newsCategory.create({ data });
      return toEntity(row);
    } catch (err) {
      // P2002 — UNIQUE(name) collision from a concurrent create racing past the use
      // case's findByName TOCTOU check (review fix L5). Map to the typed conflict
      // error so the route 409s instead of an unmapped 500.
      if ((err as { code?: string } | null)?.code === 'P2002') {
        throw new NewsCategoryNameConflictError(data.name);
      }
      throw err;
    }
  }

  async update(id: string, data: Partial<{ name: string; color: string }>): Promise<NewsCategory | null> {
    try {
      const row = await prisma.newsCategory.update({ where: { id }, data });
      return toEntity(row);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      // P2025 — genuine record-not-found (the only legitimate null path).
      if (code === 'P2025') return null;
      // P2002 — UNIQUE(name) collision from a concurrent rename racing past the use
      // case's findByName TOCTOU check (review fix L5).
      if (code === 'P2002') throw new NewsCategoryNameConflictError(data.name ?? '');
      // Anything else (connection drop, ...) MUST surface — never silently null
      // (review fix M1: this used to be `catch { return null; }`).
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await prisma.newsCategory.delete({ where: { id } });
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      // P2025 — already gone. DeleteNewsCategory pre-checks findById + countPosts, so
      // this is only a benign race (row deleted between the check and this call) —
      // stays a no-op so the port is idempotent (molde PrismaTaskAttachmentRepository).
      if (code === 'P2025') return;
      // P2003 — FK RESTRICT: a post was created between countPosts() and this delete
      // (TOCTOU race). Surface the typed domain error instead of the old silent
      // swallow, which left the category (and the post referencing it) alive behind
      // a false 204 (review fix M2).
      if (code === 'P2003') throw new NewsCategoryInUseError(await this.countPosts(id));
      // Anything else (connection drop, ...) MUST surface — never silently swallowed.
      throw err;
    }
  }

  async countPosts(id: string): Promise<number> {
    return prisma.newsPost.count({ where: { categoryId: id } });
  }
}
