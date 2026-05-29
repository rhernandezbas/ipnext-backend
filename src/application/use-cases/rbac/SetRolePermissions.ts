/**
 * SetRolePermissions — atomically replaces the grant set of a role.
 *
 * SDD #3 Phase 4a — used by PUT /api/admin/rbac/roles/:id/permissions.
 *
 * Invariants enforced:
 *   1. Role must exist — throws RoleNotFoundError (ROLE_NOT_FOUND)
 *   2. super_admin cannot be modified — throws SuperAdminImmutableError (SUPER_ADMIN_IMMUTABLE)
 *   3. All permissionIds must exist in the catalog — throws InvalidPermissionIdsError (INVALID_PERMISSION_IDS)
 *   4. Replace is atomic via rolePermRepo.replaceForRole (wraps in $transaction in Prisma adapter)
 */
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';
import type { RbacRolePermissionRepository } from '@domain/ports/RbacRolePermissionRepository';
import type { RbacPermissionRepository } from '@domain/ports/RbacPermissionRepository';
import {
  RoleNotFoundError,
  SuperAdminImmutableError,
  InvalidPermissionIdsError,
} from '@domain/errors/rbacUser.errors';

export class SetRolePermissions {
  constructor(
    private readonly roleRepo: RbacRoleRepository,
    private readonly rolePermRepo: RbacRolePermissionRepository,
    private readonly permRepo: RbacPermissionRepository,
  ) {}

  async execute(roleId: string, permissionIds: string[]): Promise<string[]> {
    const role = await this.roleRepo.findById(roleId);
    if (!role) throw new RoleNotFoundError(roleId);

    if (role.code === 'super_admin') {
      throw new SuperAdminImmutableError();
    }

    // Validate that every provided permissionId exists in the catalog
    if (permissionIds.length > 0) {
      const catalog = await this.permRepo.listAll();
      const validIds = new Set(catalog.map(p => p.id));
      const unknownIds = permissionIds.filter(id => !validIds.has(id));
      if (unknownIds.length > 0) {
        throw new InvalidPermissionIdsError(unknownIds);
      }
    }

    await this.rolePermRepo.replaceForRole(roleId, permissionIds);

    // Return the resulting permission IDs
    return this.rolePermRepo.listForRole(roleId);
  }
}
