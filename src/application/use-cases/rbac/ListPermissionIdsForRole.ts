/**
 * ListPermissionIdsForRole — returns the permission IDs currently granted to a role.
 *
 * SDD #3 Phase 4a — used by GET /api/admin/rbac/roles/:id/permissions.
 * The FE uses this to pre-populate matrix checkboxes when selecting a role.
 */
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';
import type { RbacRolePermissionRepository } from '@domain/ports/RbacRolePermissionRepository';
import { RoleNotFoundError } from '@domain/errors/rbacUser.errors';

export class ListPermissionIdsForRole {
  constructor(
    private readonly roleRepo: RbacRoleRepository,
    private readonly rolePermRepo: RbacRolePermissionRepository,
  ) {}

  async execute(roleId: string): Promise<string[]> {
    const role = await this.roleRepo.findById(roleId);
    if (!role) throw new RoleNotFoundError(roleId);
    return this.rolePermRepo.listForRole(roleId);
  }
}
