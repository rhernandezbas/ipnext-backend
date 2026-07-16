import { prisma } from '../../database/prisma';
import type { NewsPost, NewsPostWithReadState } from '@domain/entities/news';
import type {
  NewsPostRepository,
  NewsPostListFilters,
  CreateNewsPostData,
  UpdateNewsPostData,
} from '@domain/ports/NewsPostRepository';

interface NewsPostRow {
  id: string;
  title: string;
  body: string;
  categoryId: string;
  category: { id: string; name: string; color: string };
  authorId: string | null;
  authorName: string;
  pinned: boolean;
  publishedAt: Date;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toEntity(row: NewsPostRow): NewsPost {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    categoryId: row.categoryId,
    category: { id: row.category.id, name: row.category.name, color: row.category.color },
    authorId: row.authorId,
    authorName: row.authorName,
    pinned: row.pinned,
    publishedAt: row.publishedAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaNewsPostRepository implements NewsPostRepository {
  async create(input: CreateNewsPostData): Promise<NewsPost> {
    const row = await prisma.newsPost.create({
      data: {
        title: input.title,
        body: input.body,
        categoryId: input.categoryId,
        authorId: input.authorId,
        authorName: input.authorName,
        pinned: input.pinned ?? false,
      },
      include: { category: true },
    });
    return toEntity(row);
  }

  async update(id: string, patch: UpdateNewsPostData): Promise<NewsPost | null> {
    try {
      const row = await prisma.newsPost.update({
        where: { id },
        data: {
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.body !== undefined && { body: patch.body }),
          ...(patch.categoryId !== undefined && { categoryId: patch.categoryId }),
          ...(patch.pinned !== undefined && { pinned: patch.pinned }),
        },
        include: { category: true },
      });
      return toEntity(row);
    } catch {
      return null;
    }
  }

  async findById(id: string, userId: string): Promise<NewsPostWithReadState | null> {
    const row = await prisma.newsPost.findUnique({
      where: { id },
      include: { category: true, readReceipts: { where: { userId }, take: 1 } },
    });
    if (!row) return null;
    return { ...toEntity(row), read: row.readReceipts.length > 0 };
  }

  async list(filters: NewsPostListFilters, userId: string): Promise<NewsPostWithReadState[]> {
    const wantArchived = filters.archived === true;
    const rows = await prisma.newsPost.findMany({
      where: {
        archivedAt: wantArchived ? { not: null } : null,
        ...(filters.categoryId && { categoryId: filters.categoryId }),
      },
      include: { category: true, readReceipts: { where: { userId }, take: 1 } },
      orderBy: [{ pinned: 'desc' }, { publishedAt: 'desc' }],
    });
    return rows.map((row) => ({ ...toEntity(row), read: row.readReceipts.length > 0 }));
  }

  async setArchived(id: string, archived: boolean): Promise<NewsPost | null> {
    try {
      const row = await prisma.newsPost.update({
        where: { id },
        data: { archivedAt: archived ? new Date() : null },
        include: { category: true },
      });
      return toEntity(row);
    } catch {
      return null;
    }
  }

  /** Upsert on the (newsPostId, userId) unique constraint — idempotent by construction. */
  async markRead(postId: string, userId: string): Promise<void> {
    await prisma.newsReadReceipt.upsert({
      where: { newsPostId_userId: { newsPostId: postId, userId } },
      create: { newsPostId: postId, userId },
      update: {},
    });
  }

  /** Barato: un COUNT con NOT EXISTS (readReceipts.none) — design §7. */
  async countUnread(userId: string): Promise<number> {
    return prisma.newsPost.count({
      where: {
        archivedAt: null,
        readReceipts: { none: { userId } },
      },
    });
  }
}
