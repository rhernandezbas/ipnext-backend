/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: `as any` casts on the Prisma client calls are used because the generated
 * client may lag the enriched schema until `npm run prisma:generate` runs against
 * the new migration. Runtime behaviour IS correct once the migration is applied.
 * Mirrors PrismaIClassSoTypeRepository, keyed by `nodeId` instead of `code`.
 */
import { IClassNode } from '@domain/entities/iclass-node';
import { IClassNodeRepository, UpsertNodeInput } from '@domain/ports/IClassNodeRepository';
import { prisma } from '../../database/prisma';

function mapRow(row: any): IClassNode {
  return {
    id: row.id,
    nodeId: row.nodeId,
    code: row.code,
    description: row.description,
    active: row.active,
    selectable: row.selectable,
    lastSyncedAt: row.lastSyncedAt instanceof Date ? row.lastSyncedAt : new Date(row.lastSyncedAt),
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt),
  };
}

export class PrismaIClassNodeRepository implements IClassNodeRepository {
  async list(filter?: { active?: boolean; selectable?: boolean }): Promise<IClassNode[]> {
    const where: Record<string, boolean> = {};
    if (filter?.active !== undefined) where['active'] = filter.active;
    if (filter?.selectable !== undefined) where['selectable'] = filter.selectable;
    const rows = await (prisma as any).iClassNode.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { code: 'asc' },
    });
    return rows.map(mapRow);
  }

  async getById(id: string): Promise<IClassNode | null> {
    const row = await (prisma as any).iClassNode.findUnique({ where: { id } });
    return row ? mapRow(row) : null;
  }

  async upsertByNodeId(
    node: UpsertNodeInput,
  ): Promise<{ status: 'created' | 'updated' | 'reactivated' }> {
    const now = new Date();

    const existing = await (prisma as any).iClassNode.findUnique({ where: { nodeId: node.nodeId } });

    let status: 'created' | 'updated' | 'reactivated';
    if (!existing) {
      status = 'created';
    } else if (existing.active === false) {
      status = 'reactivated';
    } else {
      status = 'updated';
    }

    await (prisma as any).iClassNode.upsert({
      where: { nodeId: node.nodeId },
      create: {
        nodeId: node.nodeId,
        code: node.code,
        description: node.description,
        selectable: node.selectable,
        active: true,
        lastSyncedAt: now,
      },
      update: {
        code: node.code,
        description: node.description,
        selectable: node.selectable,
        active: true,
        lastSyncedAt: now,
        updatedAt: now,
      },
    });

    return { status };
  }

  async markInactiveExcept(presentNodeIds: number[]): Promise<number> {
    const now = new Date();
    const result = await (prisma as any).iClassNode.updateMany({
      where: { nodeId: { notIn: presentNodeIds }, active: true },
      data: { active: false, lastSyncedAt: now, updatedAt: now },
    });
    return result.count;
  }
}
