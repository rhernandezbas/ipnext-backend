import type { RbacRolePermissionRepository } from '@domain/ports/RbacRolePermissionRepository';

/**
 * InMemoryRbacRolePermissionRepository — test seam for RbacRolePermissionRepository.
 *
 * Stores (roleId, permissionId) pairs in a Set for O(1) idempotent grant/revoke.
 * listForRole returns string[] (permission ids) — the port's minimal contract.
 */
export class InMemoryRbacRolePermissionRepository implements RbacRolePermissionRepository {
  /** Key format: `${roleId}::${permissionId}` */
  private readonly grants = new Set<string>();

  private key(roleId: string, permissionId: string): string {
    return `${roleId}::${permissionId}`;
  }

  async grant(roleId: string, permissionId: string): Promise<void> {
    this.grants.add(this.key(roleId, permissionId));
  }

  async revoke(roleId: string, permissionId: string): Promise<void> {
    this.grants.delete(this.key(roleId, permissionId));
  }

  async listForRole(roleId: string): Promise<string[]> {
    const prefix = `${roleId}::`;
    const permissionIds: string[] = [];
    for (const key of this.grants) {
      if (key.startsWith(prefix)) {
        permissionIds.push(key.slice(prefix.length));
      }
    }
    return permissionIds;
  }

  async replaceForRole(roleId: string, permissionIds: string[]): Promise<void> {
    // Drop all current grants for this role
    const prefix = `${roleId}::`;
    for (const key of [...this.grants]) {
      if (key.startsWith(prefix)) {
        this.grants.delete(key);
      }
    }
    // Insert the new set
    for (const permissionId of permissionIds) {
      this.grants.add(this.key(roleId, permissionId));
    }
  }
}
