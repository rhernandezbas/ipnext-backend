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

  /**
   * Atomically replaces the full grant set for a role.
   * Drops all existing grants for roleId, then inserts permissionIds.
   * Idempotent: calling twice with the same set produces the same final state.
   */
  replaceForRole(roleId: string, permissionIds: string[]): Promise<void>;
}
