import { prisma } from '../../database/prisma';
import type { CannedResponse } from '@domain/entities/cannedResponse';
import type { CannedResponseListQuery, CannedResponseRepository } from '@domain/ports/CannedResponseRepository';
import { ShortcutTakenError } from '@domain/errors/cannedResponses';

function toEntity(row: {
  id: string;
  shortcut: string;
  content: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CannedResponse {
  return {
    id: row.id,
    shortcut: row.shortcut,
    content: row.content,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaCannedResponseRepository implements CannedResponseRepository {
  async list(query?: CannedResponseListQuery): Promise<CannedResponse[]> {
    const q = query?.q?.trim();
    const rows = await prisma.cannedResponse.findMany({
      where: q
        ? {
            OR: [
              { shortcut: { contains: q, mode: 'insensitive' } },
              { content: { contains: q, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: { shortcut: 'asc' },
    });
    return rows.map(toEntity);
  }

  async findById(id: string): Promise<CannedResponse | null> {
    const row = await prisma.cannedResponse.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async findByShortcut(shortcut: string): Promise<CannedResponse | null> {
    // El shortcut se persiste SIEMPRE normalizado (lowercase-slug) → match exacto por el UNIQUE.
    const row = await prisma.cannedResponse.findUnique({ where: { shortcut } });
    return row ? toEntity(row) : null;
  }

  async create(input: { shortcut: string; content: string; createdById: string | null }): Promise<CannedResponse> {
    try {
      const row = await prisma.cannedResponse.create({ data: input });
      return toEntity(row);
    } catch (err) {
      // P2002 — UNIQUE(shortcut) por una carrera que pasó el findByShortcut del use case.
      if ((err as { code?: string } | null)?.code === 'P2002') {
        throw new ShortcutTakenError(input.shortcut);
      }
      throw err;
    }
  }

  async update(id: string, patch: { shortcut?: string; content?: string }): Promise<CannedResponse | null> {
    try {
      const row = await prisma.cannedResponse.update({ where: { id }, data: patch });
      return toEntity(row);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      // P2025 — registro inexistente (único camino legítimo a null).
      if (code === 'P2025') return null;
      // P2002 — UNIQUE(shortcut) por una carrera de rename que pasó el check del use case.
      if (code === 'P2002') throw new ShortcutTakenError(patch.shortcut ?? '');
      // Cualquier otra cosa (drop de conexión, ...) DEBE propagar — nunca null silencioso.
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await prisma.cannedResponse.delete({ where: { id } });
    } catch (err) {
      // P2025 — ya no existe. DeleteCannedResponse pre-chequea findById, así que esto
      // es sólo una carrera benigna → no-op idempotente (molde PrismaNewsCategoryRepository).
      if ((err as { code?: string } | null)?.code === 'P2025') return;
      throw err;
    }
  }
}
