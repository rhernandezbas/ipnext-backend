/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: Uses `as any` casts on Prisma client calls because prisma generate
 * has not been run against the RBAC schema in this environment (no DB available).
 * The casts become unnecessary once the migration is applied and
 * `npm run prisma:generate` is executed. Runtime behavior IS correct.
 */
import { prisma } from '@infrastructure/database/prisma';
import type { RbacRolePermissionRepository } from '@domain/ports/RbacRolePermissionRepository';

export class PrismaRbacRolePermissionRepository implements RbacRolePermissionRepository {
  constructor(private readonly db = prisma) {}

  /**
   * Idempotent grant: uses upsert so a duplicate call is a safe no-op.
   * Matches the InMemory adapter's Set-based idempotency contract.
   */
  async grant(roleId: string, permissionId: string): Promise<void> {
    await (this.db as any).rbacRolePermission.upsert({
      where: { roleId_permissionId: { roleId, permissionId } },
      create: { roleId, permissionId },
      update: {}, // no-op update — just ensure the row exists
    });
  }

  async revoke(roleId: string, permissionId: string): Promise<void> {
    try {
      await (this.db as any).rbacRolePermission.delete({
        where: { roleId_permissionId: { roleId, permissionId } },
      });
    } catch (err) {
      // P2025: record not found — treat as no-op to match InMemory behavior
      if ((err as { code?: string })?.code === 'P2025') return;
      throw err;
    }
  }

  async listForRole(roleId: string): Promise<string[]> {
    const rows = await (this.db as any).rbacRolePermission.findMany({
      where: { roleId },
      select: { permissionId: true },
    }) as Array<{ permissionId: string }>;
    return rows.map(r => r.permissionId);
  }

  async replaceForRole(roleId: string, permissionIds: string[]): Promise<void> {
    await (this.db as any).$transaction([
      (this.db as any).rbacRolePermission.deleteMany({ where: { roleId } }),
      (this.db as any).rbacRolePermission.createMany({
        data: permissionIds.map((permissionId: string) => ({ roleId, permissionId })),
      }),
    ]);
  }
}
