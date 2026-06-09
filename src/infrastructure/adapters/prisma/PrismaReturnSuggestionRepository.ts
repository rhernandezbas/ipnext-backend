/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ReturnSuggestionRepository,
  SetReturnSuggestionStatusInput,
} from '@domain/ports/ReturnSuggestionRepository';
import {
  ReturnSuggestion,
  ReturnSuggestionStatus,
  ReturnResolution,
} from '@domain/entities/return-suggestion';
import { prisma } from '../../database/prisma';
import { PrismaClientLike } from './PrismaClientLike';

function toEntity(r: any): ReturnSuggestion {
  return {
    id: r.id,
    taskId: r.taskId,
    serviceOrderId: r.serviceOrderId,
    serialNumber: r.serialNumber ?? null,
    mac: r.mac ?? null,
    deviceType: r.deviceType ?? null,
    matchedAssetId: r.matchedAssetId ?? null,
    status: r.status as ReturnSuggestionStatus,
    resolution: (r.resolution ?? null) as ReturnResolution | null,
    confirmedMovementId: r.confirmedMovementId ?? null,
    sourceRef: r.sourceRef ?? null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  };
}

/**
 * Prisma adapter for ReturnSuggestion (EPIC #38 W4).
 *
 * `create` honors the @@unique([serviceOrderId, serialNumber]) by catching P2002 and
 * returning the existing row — a partial-crash re-stage dedups silently. Tx-scoped: a
 * `Prisma.TransactionClient` can be injected so the confirm setStatus joins the outer
 * UnitOfWork transaction (atomic with the RETURN movement).
 */
export class PrismaReturnSuggestionRepository implements ReturnSuggestionRepository {
  constructor(private readonly db: PrismaClientLike = prisma) {}

  async create(suggestion: ReturnSuggestion): Promise<ReturnSuggestion> {
    try {
      const row = await (this.db as any).returnSuggestion.create({
        data: {
          id: suggestion.id,
          taskId: suggestion.taskId,
          serviceOrderId: suggestion.serviceOrderId,
          serialNumber: suggestion.serialNumber,
          mac: suggestion.mac,
          deviceType: suggestion.deviceType,
          matchedAssetId: suggestion.matchedAssetId,
          status: suggestion.status,
          resolution: suggestion.resolution,
          confirmedMovementId: suggestion.confirmedMovementId,
          sourceRef: suggestion.sourceRef,
        },
      });
      return toEntity(row);
    } catch (e) {
      // @@unique([serviceOrderId, serialNumber]) collision → return the existing row.
      if (e && typeof e === 'object' && (e as { code?: string }).code === 'P2002') {
        const existing = await (this.db as any).returnSuggestion.findFirst({
          where: { serviceOrderId: suggestion.serviceOrderId, serialNumber: suggestion.serialNumber },
        });
        if (existing) return toEntity(existing);
      }
      throw e;
    }
  }

  async get(id: string): Promise<ReturnSuggestion | null> {
    const row = await (this.db as any).returnSuggestion.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async listPending(): Promise<ReturnSuggestion[]> {
    const rows = await (this.db as any).returnSuggestion.findMany({
      where: { status: { in: ['pending', 'needs_review'] } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toEntity);
  }

  async listByTask(taskId: string): Promise<ReturnSuggestion[]> {
    const rows = await (this.db as any).returnSuggestion.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toEntity);
  }

  async setStatus(id: string, patch: SetReturnSuggestionStatusInput): Promise<ReturnSuggestion | null> {
    const data: Record<string, unknown> = { status: patch.status };
    if (patch.resolution !== undefined) data.resolution = patch.resolution;
    if (patch.confirmedMovementId !== undefined) data.confirmedMovementId = patch.confirmedMovementId;
    if (patch.sourceRef !== undefined) data.sourceRef = patch.sourceRef;
    if (patch.matchedAssetId !== undefined) data.matchedAssetId = patch.matchedAssetId;
    try {
      const row = await (this.db as any).returnSuggestion.update({ where: { id }, data });
      return toEntity(row);
    } catch {
      return null; // record not found
    }
  }

  async findBySourceRef(sourceRef: string): Promise<ReturnSuggestion | null> {
    // Fix #5: keys on the dedicated sourceRef column (confirmedMovementId now holds the uuid).
    const row = await (this.db as any).returnSuggestion.findFirst({
      where: { sourceRef },
    });
    return row ? toEntity(row) : null;
  }
}
