/**
 * RbacRolePermissionRepository — domain port.
 *
 * Manages the many-to-many pivot between RbacRole and RbacPermission.
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */

export interface RbacRolePermissionRepository {
  /** Idempotent — upsert semantics; no error if already granted. */
  grant(roleId: string, permissionId: string): Promise<void>;

  revoke(roleId: string, permissionId: string): Promise<void>;

  /** Returns the permission IDs granted to the role. */
  listForRole(roleId: string): Promise<string[]>;
}
