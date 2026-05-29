import { randomUUID } from 'crypto';
import type { RbacPermission, RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import type { RbacPermissionRepository } from '@domain/ports/RbacPermissionRepository';

interface SeedInput {
  moduleCode: RbacModuleCode;
  action: PermissionAction;
}

/**
 * InMemoryRbacPermissionRepository — test seam for RbacPermissionRepository.
 *
 * `seed` is an extra helper for tests — NOT part of the port. Prisma populates
 * permissions via the catalog migration SQL.
 */
export class InMemoryRbacPermissionRepository implements RbacPermissionRepository {
  private readonly store = new Map<string, RbacPermission>();

  async listAll(): Promise<RbacPermission[]> {
    return Array.from(this.store.values()).map(p => ({ ...p }));
  }

  async findByModuleAndAction(
    moduleCode: string,
    action: PermissionAction,
  ): Promise<RbacPermission | null> {
    for (const perm of this.store.values()) {
      if (perm.moduleCode === moduleCode && perm.action === action) {
        return { ...perm };
      }
    }
    return null;
  }

  /** Test helper — seeds a permission. NOT part of RbacPermissionRepository port. */
  async seed(input: SeedInput): Promise<RbacPermission> {
    const perm: RbacPermission = {
      id: randomUUID(),
      moduleCode: input.moduleCode,
      action: input.action,
    };
    this.store.set(perm.id, perm);
    return { ...perm };
  }
}
