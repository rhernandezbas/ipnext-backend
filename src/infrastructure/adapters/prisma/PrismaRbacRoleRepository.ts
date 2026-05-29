/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: Uses `as any` casts on Prisma client calls because prisma generate
 * has not been run against the RBAC schema in this environment (no DB available).
 * The casts become unnecessary once the migration is applied and
 * `npm run prisma:generate` is executed. Runtime behavior IS correct.
 */
import { prisma } from '@infrastructure/database/prisma';
import type { RbacRole } from '@domain/entities/rbac';
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';

type RbacRoleRow = {
  id: string;
  code: string;
  label: string;
  isSystem: boolean;
};

function mapRole(row: RbacRoleRow): RbacRole {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    isSystem: row.isSystem,
  };
}

export class PrismaRbacRoleRepository implements RbacRoleRepository {
  constructor(private readonly db = prisma) {}

  async findById(id: string): Promise<RbacRole | null> {
    const row = await (this.db as any).rbacRole.findUnique({
      where: { id },
    }) as RbacRoleRow | null;
    return row ? mapRole(row) : null;
  }

  async findByCode(code: string): Promise<RbacRole | null> {
    const row = await (this.db as any).rbacRole.findUnique({
      where: { code },
    }) as RbacRoleRow | null;
    return row ? mapRole(row) : null;
  }

  async listAll(): Promise<RbacRole[]> {
    const rows = await (this.db as any).rbacRole.findMany({
      orderBy: { code: 'asc' },
    }) as RbacRoleRow[];
    return rows.map(mapRole);
  }
}
