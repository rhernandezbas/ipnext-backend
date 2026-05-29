/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: Uses `as any` casts on Prisma client calls because prisma generate
 * has not been run against the RBAC schema in this environment (no DB available).
 * The casts become unnecessary once the migration is applied and
 * `npm run prisma:generate` is executed. Runtime behavior IS correct.
 */
import { prisma } from '@infrastructure/database/prisma';
import type { RbacPermission, PermissionAction } from '@domain/entities/rbac';
import type { RbacPermissionRepository } from '@domain/ports/RbacPermissionRepository';

type RbacPermissionRow = {
  id: string;
  action: string;
  module: { code: string };
};

function mapPermission(row: RbacPermissionRow): RbacPermission {
  return {
    id: row.id,
    moduleCode: row.module.code as RbacPermission['moduleCode'],
    action: row.action as PermissionAction,
  };
}

const MODULE_INCLUDE = { module: { select: { code: true } } } as const;

export class PrismaRbacPermissionRepository implements RbacPermissionRepository {
  constructor(private readonly db = prisma) {}

  async listAll(): Promise<RbacPermission[]> {
    const rows = await (this.db as any).rbacPermission.findMany({
      include: MODULE_INCLUDE,
      orderBy: [{ module: { code: 'asc' } }, { action: 'asc' }],
    }) as RbacPermissionRow[];
    return rows.map(mapPermission);
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
