/**
 * ListAllPermissionsWithModule — returns the full permission catalog.
 *
 * SDD #3 Phase 4a — used by GET /api/admin/rbac/permissions.
 * Returns every permission with its moduleCode and action.
 * The FE uses this to render the matrix column headers, grouped by module.
 */
import type { RbacPermission } from '@domain/entities/rbac';
import type { RbacPermissionRepository } from '@domain/ports/RbacPermissionRepository';

export class ListAllPermissionsWithModule {
  constructor(private readonly permissionRepo: RbacPermissionRepository) {}

  async execute(): Promise<RbacPermission[]> {
    return this.permissionRepo.listAll();
  }
}
