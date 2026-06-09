import { IClassResultCode } from '@domain/entities/iclass-result-code';
import {
  IClassResultCodeRepository,
  UpsertResultCodeInput,
} from '@domain/ports/IClassResultCodeRepository';
import { prisma } from '../../database/prisma';
import { normalizeResultCode } from '@application/use-cases/normalizeResultCode';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEntity(row: any): IClassResultCode {
  return {
    id: row.id,
    soTypeId: row.soTypeId != null ? String(row.soTypeId) : null,
    code: row.code,
    type: row.type,
    mappedStageId: row.mappedStageId ?? null,
    mappedStageName: row.mappedStage?.name ?? null,
    isRemovalCode: row.isRemovalCode ?? false,
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const INCLUDE = { mappedStage: { select: { name: true } } } as const;

export class PrismaIClassResultCodeRepository implements IClassResultCodeRepository {
  async list(filter?: { mapped?: boolean }): Promise<IClassResultCode[]> {
    const where: Record<string, unknown> = {};
    if (filter?.mapped === true) where.mappedStageId = { not: null };
    if (filter?.mapped === false) where.mappedStageId = null;
    const rows = await (prisma.iClassResultCode as any).findMany({ where, include: INCLUDE, orderBy: { code: 'asc' } });
    return rows.map(toEntity);
  }

  async getById(id: string): Promise<IClassResultCode | null> {
    const row = await (prisma.iClassResultCode as any).findUnique({ where: { id }, include: INCLUDE });
    return row ? toEntity(row) : null;
  }

  async findByCode(code: string): Promise<IClassResultCode | null> {
    // IClass varies the casing/whitespace of motivoFechamento vs the operator's
    // catalog (e.g. "Cambio de Domicilio Realizado" vs "CAMBIO DE DOMICILIO
    // REALIZADO"), so match case-insensitively + trimmed.
    const row = await (prisma.iClassResultCode as any).findFirst({
      where: { code: { equals: code.trim(), mode: 'insensitive' } },
      include: INCLUDE,
    });
    return row ? toEntity(row) : null;
  }

  async findBySoTypeAndCode(soTypeId: string, code: string): Promise<IClassResultCode | null> {
    const row = await (prisma.iClassResultCode as any).findFirst({
      where: { soTypeId: BigInt(soTypeId), code: { equals: code.trim(), mode: 'insensitive' } },
      include: INCLUDE,
    });
    return row ? toEntity(row) : null;
  }

  async findBySoTypeAndCodeNormalized(soTypeId: string, code: string): Promise<IClassResultCode | null> {
    // Prisma no puede aplicar strip de puntuación final en WHERE, así que traemos
    // los candidatos por soTypeId (catálogo pequeño: ~71 filas) y comparamos en JS.
    const rows = await (prisma.iClassResultCode as any).findMany({
      where: { soTypeId: BigInt(soTypeId) },
      include: INCLUDE,
    });
    const norm = normalizeResultCode(code);
    const match = rows.find((r: any) => normalizeResultCode(r.code) === norm);
    return match ? toEntity(match) : null;
  }

  async findByCodeNormalized(code: string): Promise<IClassResultCode | null> {
    // Traemos todos (catálogo pequeño) y comparamos normalizados en JS.
    const rows = await (prisma.iClassResultCode as any).findMany({ include: INCLUDE });
    const norm = normalizeResultCode(code);
    const match = rows.find((r: any) => normalizeResultCode(r.code) === norm);
    return match ? toEntity(match) : null;
  }

  async upsert(entry: UpsertResultCodeInput): Promise<{ status: 'created' | 'updated' }> {
    // findFirst-then-write rather than upsert: the (soTypeId, code) compound unique
    // includes a nullable soTypeId, which Prisma cannot target reliably in upsert.
    const soTypeId = entry.soTypeId != null ? BigInt(entry.soTypeId) : null;
    const existing = await (prisma.iClassResultCode as any).findFirst({
      where: { soTypeId, code: entry.code },
      select: { id: true },
    });
    if (existing) {
      await (prisma.iClassResultCode as any).update({
        where: { id: existing.id },
        // PRESERVE mappedStageId — never cleared by a sync.
        data: { type: entry.type, lastSyncedAt: new Date() },
      });
      return { status: 'updated' };
    }
    await (prisma.iClassResultCode as any).create({
      data: { soTypeId, code: entry.code, type: entry.type, lastSyncedAt: new Date() },
    });
    return { status: 'created' };
  }

  async assignStage(id: string, stageId: string | null): Promise<IClassResultCode | null> {
    try {
      const row = await (prisma.iClassResultCode as any).update({
        where: { id },
        data: { mappedStageId: stageId },
        include: INCLUDE,
      });
      return toEntity(row);
    } catch {
      return null; // record not found
    }
  }
}
