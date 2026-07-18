import { NewsPostAttachmentRepository } from '@domain/ports/NewsPostAttachmentRepository';
import {
  NewsPostAttachment,
  NewsPostAttachmentKind,
} from '@domain/entities/newsPostAttachment';
import { prisma } from '../../database/prisma';

function toEntity(row: {
  id: string;
  newsPostId: string;
  kind: string;
  storageKey: string | null;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  url: string | null;
  uploadedById: string;
  createdAt: Date | string;
}): NewsPostAttachment {
  return {
    id: row.id,
    newsPostId: row.newsPostId,
    kind: row.kind as NewsPostAttachmentKind,
    storageKey: row.storageKey ?? null,
    filename: row.filename ?? null,
    mimeType: row.mimeType ?? null,
    sizeBytes: row.sizeBytes ?? null,
    url: row.url ?? null,
    uploadedById: row.uploadedById,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

export class PrismaNewsPostAttachmentRepository implements NewsPostAttachmentRepository {
  async create(attachment: NewsPostAttachment): Promise<NewsPostAttachment> {
    const row = await prisma.newsPostAttachment.create({
      data: {
        id: attachment.id,
        newsPostId: attachment.newsPostId,
        kind: attachment.kind,
        storageKey: attachment.storageKey,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        url: attachment.url,
        uploadedById: attachment.uploadedById,
      },
    });
    return toEntity(row);
  }

  async findById(id: string): Promise<NewsPostAttachment | null> {
    const row = await prisma.newsPostAttachment.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async findByNewsPostId(newsPostId: string): Promise<NewsPostAttachment[]> {
    const rows = await prisma.newsPostAttachment.findMany({
      where: { newsPostId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toEntity);
  }

  async findByNewsPostIds(newsPostIds: string[]): Promise<NewsPostAttachment[]> {
    if (newsPostIds.length === 0) return [];
    const rows = await prisma.newsPostAttachment.findMany({
      where: { newsPostId: { in: newsPostIds } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toEntity);
  }

  async delete(id: string): Promise<void> {
    // Idempotente SOLO para "no existe" (P2025). Cualquier otro error DEBE propagarse.
    try {
      await prisma.newsPostAttachment.delete({ where: { id } });
    } catch (e) {
      if ((e as { code?: string } | null)?.code === 'P2025') return;
      throw e;
    }
  }

  async countByNewsPostId(newsPostId: string): Promise<number> {
    return prisma.newsPostAttachment.count({ where: { newsPostId } });
  }
}
