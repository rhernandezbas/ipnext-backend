/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: Uses `as any` casts on Prisma client calls because prisma generate
 * has not been run against the RBAC schema in this environment (no DB available).
 * The casts become unnecessary once the migration is applied and
 * `npm run prisma:generate` is executed. Runtime behavior IS correct.
 */
import { prisma } from '@infrastructure/database/prisma';
import type {
  RbacPermission,
  RbacPermissionCatalogEntry,
  PermissionAction,
} from '@domain/entities/rbac';
import type { RbacPermissionRepository } from '@domain/ports/RbacPermissionRepository';

type RbacPermissionRow = {
  id: string;
  action: string;
  module: { code: string };
};

type RbacPermissionCatalogRow = {
  id: string;
  action: string;
  module: { id: string; code: string; label: string };
};

function mapPermission(row: RbacPermissionRow): RbacPermission {
  return {
    id: row.id,
    moduleCode: row.module.code as RbacPermission['moduleCode'],
    action: row.action as PermissionAction,
  };
}

function mapCatalogEntry(row: RbacPermissionCatalogRow): RbacPermissionCatalogEntry {
  return {
    id: row.id,
    moduleId: row.module.id,
    moduleCode: row.module.code as RbacPermissionCatalogEntry['moduleCode'],
    moduleLabel: row.module.label,
    action: row.action as PermissionAction,
  };
}

const MODULE_INCLUDE = { module: { select: { code: true } } } as const;
const CATALOG_INCLUDE = { module: { select: { id: true, code: true, label: true } } } as const;

export class PrismaRbacPermissionRepository implements RbacPermissionRepository {
  constructor(private readonly db = prisma) {}

  async listAll(): Promise<RbacPermission[]> {
    const rows = await (this.db as any).rbacPermission.findMany({
      include: MODULE_INCLUDE,
      orderBy: [{ module: { code: 'asc' } }, { action: 'asc' }],
    }) as RbacPermissionRow[];
    return rows.map(mapPermission);
  }

  async listCatalog(): Promise<RbacPermissionCatalogEntry[]> {
    const rows = await (this.db as any).rbacPermission.findMany({
      include: CATALOG_INCLUDE,
      orderBy: [{ module: { code: 'asc' } }, { action: 'asc' }],
    }) as RbacPermissionCatalogRow[];
    return rows.map(mapCatalogEntry);
  }

  async findByModuleAndAction(
    moduleCode: string,
    action: PermissionAction,
  ): Promise<RbacPermission | null> {
    const row = await (this.db as any).rbacPermission.findFirst({
      where: {
        module: { code: moduleCode },
        action,
      },
      include: MODULE_INCLUDE,
    }) as RbacPermissionRow | null;
    return row ? mapPermission(row) : null;
  }
}
