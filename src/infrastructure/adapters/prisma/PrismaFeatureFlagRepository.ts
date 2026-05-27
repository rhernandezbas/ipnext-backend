import { FeatureFlag, FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { prisma } from '../../database/prisma';

function toFeatureFlag(row: any): FeatureFlag {
  return {
    key: row.key,
    enabled: row.enabled,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

export class PrismaFeatureFlagRepository implements FeatureFlagRepository {
  async list(): Promise<FeatureFlag[]> {
    const rows = await (prisma as any).featureFlag.findMany({ orderBy: { key: 'asc' } });
    return rows.map(toFeatureFlag);
  }

  async get(key: string): Promise<FeatureFlag | null> {
    const row = await (prisma as any).featureFlag.findUnique({ where: { key } });
    return row ? toFeatureFlag(row) : null;
  }

  async setEnabled(key: string, enabled: boolean): Promise<FeatureFlag> {
    const row = await (prisma as any).featureFlag.update({ where: { key }, data: { enabled } });
    return toFeatureFlag(row);
  }
}
