/**
 * ListAllPermissionsWithModule — returns the full permission catalog.
 *
 * SDD #3 Phase 4a — used by GET /api/admin/rbac/permissions.
 * Returns every permission enriched with its module id, code and display label.
 * The FE uses this to render the matrix rows (label + code), grouped by module.
 */
import type { RbacPermissionCatalogEntry } from '@domain/entities/rbac';
import type { RbacPermissionRepository } from '@domain/ports/RbacPermissionRepository';

export class ListAllPermissionsWithModule {
  constructor(private readonly permissionRepo: RbacPermissionRepository) {}

  async execute(): Promise<RbacPermissionCatalogEntry[]> {
    return this.permissionRepo.listCatalog();
  }
}
