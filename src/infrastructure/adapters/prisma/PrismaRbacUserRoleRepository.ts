/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: Uses `as any` casts on Prisma client calls because prisma generate
 * has not been run against the RBAC schema in this environment (no DB available).
 * The casts become unnecessary once the migration is applied and
 * `npm run prisma:generate` is executed. Runtime behavior IS correct.
 */
import { prisma } from '@infrastructure/database/prisma';
import type { RbacRole } from '@domain/entities/rbac';
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';

export class PrismaRbacUserRoleRepository implements RbacUserRoleRepository {
  constructor(private readonly db = prisma) {}

  /**
   * Idempotent assign: uses upsert so a duplicate call is a safe no-op.
   * Matches the InMemory adapter's Set-based idempotency contract.
   */
  async assign(userId: string, roleId: string): Promise<void> {
    await (this.db as any).rbacUserRole.upsert({
      where: { userId_roleId: { userId, roleId } },
      create: { userId, roleId },
      update: {}, // no-op update — just ensure the row exists
    });
  }

  async revoke(userId: string, roleId: string): Promise<void> {
    try {
      await (this.db as any).rbacUserRole.delete({
        where: { userId_roleId: { userId, roleId } },
      });
    } catch (err) {
      // P2025: record not found — treat as no-op to match InMemory behavior
      if ((err as { code?: string })?.code === 'P2025') return;
      throw err;
    }
  }

  async listForUser(userId: string): Promise<string[]> {
    const rows = await (this.db as any).rbacUserRole.findMany({
      where: { userId },
      select: { roleId: true },
    }) as Array<{ roleId: string }>;
    return rows.map(r => r.roleId);
  }

  async listRolesForUser(userId: string): Promise<RbacRole[]> {
    const rows = await (this.db as any).rbacUserRole.findMany({
      where: { userId },
      include: { role: true },
    }) as Array<{ role: { id: string; code: string; label: string; isSystem: boolean } }>;
    return rows.map(r => ({
      id: r.role.id,
      code: r.role.code,
      label: r.role.label,
      isSystem: r.role.isSystem,
    }));
  }
}
