import { ServiceCutBatch, ServiceCutItemResult } from '@domain/entities/serviceCutBatch';
import {
  ServiceCutBatchRepository,
  ServiceCutBatchCreate,
  ServiceCutBatchPatch,
} from '@domain/ports/ServiceCutBatchRepository';
import { prisma } from '../../database/prisma';

/**
 * PrismaServiceCutBatchRepository — persistencia del job de corte masivo (Fase C).
 * Singleton `prisma`; `(prisma as any).serviceCutBatch` por el client no regenerado en local.
 */
function model() {
  return (prisma as any).serviceCutBatch;
}

export class PrismaServiceCutBatchRepository implements ServiceCutBatchRepository {
  async create(data: ServiceCutBatchCreate): Promise<ServiceCutBatch> {
    const row = await model().create({
      data: { action: data.action, total: data.total, status: 'pending', result: [] },
    });
    return toEntity(row);
  }

  async findById(id: string): Promise<ServiceCutBatch | null> {
    const row = await model().findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async update(id: string, patch: ServiceCutBatchPatch): Promise<ServiceCutBatch> {
    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) data['status'] = patch.status;
    if (patch.doneCount !== undefined) data['doneCount'] = patch.doneCount;
    if (patch.failedCount !== undefined) data['failedCount'] = patch.failedCount;
    if (patch.result !== undefined) data['result'] = patch.result;
    if (patch.finishedAt !== undefined) {
      data['finishedAt'] = patch.finishedAt ? new Date(patch.finishedAt) : null;
    }
    const row = await model().update({ where: { id }, data });
    return toEntity(row);
  }
}

function toEntity(row: any): ServiceCutBatch {
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    total: row.total,
    doneCount: row.doneCount,
    failedCount: row.failedCount,
    result: (Array.isArray(row.result) ? row.result : []) as ServiceCutItemResult[],
    createdAt: new Date(row.createdAt).toISOString(),
    finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
  };
}
