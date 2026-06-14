/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: This file uses `(prisma as any).iClassStatusCatalog` because `prisma generate`
 * cannot be run in the worktree (shared junction node_modules). The cast is correct at
 * runtime after the migration runs and the Dockerfile regenerates the client in prod.
 */
import { IClassStatusCatalogEntry } from '@domain/entities/iclass-status-catalog';
import {
  IClassStatusCatalogRepository,
  UpsertStatusInput,
  UpdateStatusInput,
} from '@domain/ports/IClassStatusCatalogRepository';
import { prisma } from '../../database/prisma';

function toEntity(row: any): IClassStatusCatalogEntry {
  return {
    id: row.id,
    statusCode: row.statusCode,
    iclassLabel: row.iclassLabel,
    displayLabel: row.displayLabel ?? null,
    color: row.color ?? null,
    tracked: row.tracked ?? false,
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaIClassStatusCatalogRepository implements IClassStatusCatalogRepository {
  async list(): Promise<IClassStatusCatalogEntry[]> {
    const rows = await (prisma as any).iClassStatusCatalog.findMany({
      orderBy: { statusCode: 'asc' },
    });
    return rows.map(toEntity);
  }

  async getByStatusCode(statusCode: string): Promise<IClassStatusCatalogEntry | null> {
    const row = await (prisma as any).iClassStatusCatalog.findUnique({
      where: { statusCode },
    });
    return row ? toEntity(row) : null;
  }

  async upsertByStatusCode(input: UpsertStatusInput): Promise<{ status: 'created' | 'updated' }> {
    // FIX 4 — atomic upsert: replaces the old findUnique-then-create pattern which was
    // vulnerable to a P2002 race when POST /statuses/sync ran concurrently with a cron
    // tick (both can hit upsertByStatusCode at the same time on the same statusCode).
    // Prisma's native upsert is atomic on the unique column — no advisory lock needed.
    // Semantics preserved: update ONLY refreshes iclassLabel + lastSyncedAt;
    // displayLabel / color / tracked (operator config) are never overwritten.
    const now = new Date();
    const existing = await (prisma as any).iClassStatusCatalog.upsert({
      where: { statusCode: input.statusCode },
      create: {
        statusCode: input.statusCode,
        iclassLabel: input.iclassLabel,
        displayLabel: null,
        color: null,
        tracked: false,
        lastSyncedAt: now,
      },
      update: {
        // PRESERVE displayLabel / color / tracked — only refresh raw label + timestamp.
        iclassLabel: input.iclassLabel,
        lastSyncedAt: now,
      },
      select: { createdAt: true, updatedAt: true },
    });

    // Determine whether this was a create or update: createdAt === updatedAt on fresh rows.
    const isNew = existing.createdAt.getTime() === existing.updatedAt.getTime();
    return { status: isNew ? 'created' : 'updated' };
  }

  async update(statusCode: string, patch: UpdateStatusInput): Promise<IClassStatusCatalogEntry | null> {
    try {
      const data: Record<string, unknown> = {};
      if ('displayLabel' in patch) data['displayLabel'] = patch.displayLabel ?? null;
      if ('color' in patch) data['color'] = patch.color ?? null;
      if ('tracked' in patch && patch.tracked !== undefined) data['tracked'] = patch.tracked;

      const row = await (prisma as any).iClassStatusCatalog.update({
        where: { statusCode },
        data,
      });
      return toEntity(row);
    } catch {
      return null; // record not found
    }
  }

  async findManyByStatusCodes(codes: string[]): Promise<IClassStatusCatalogEntry[]> {
    if (!codes.length) return [];
    const rows = await (prisma as any).iClassStatusCatalog.findMany({
      where: { statusCode: { in: codes } },
    });
    return rows.map(toEntity);
  }
}
