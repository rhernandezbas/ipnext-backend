import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';

/**
 * InMemoryRbacUserRoleRepository — test seam for RbacUserRoleRepository.
 *
 * Stores (userId, roleId) pairs in a Set for O(1) idempotent assign/revoke.
 * listForUser returns string[] (role ids) — the port's minimal contract.
 * Full role resolution (RbacRole[]) is in RbacUserRepository.listRolesForUser.
 */
export class InMemoryRbacUserRoleRepository implements RbacUserRoleRepository {
  /** Key format: `${userId}::${roleId}` */
  private readonly assignments = new Set<string>();

  private key(userId: string, roleId: string): string {
    return `${userId}::${roleId}`;
  }

  async assign(userId: string, roleId: string): Promise<void> {
    this.assignments.add(this.key(userId, roleId));
  }

  async revoke(userId: string, roleId: string): Promise<void> {
    this.assignments.delete(this.key(userId, roleId));
  }

  async listForUser(userId: string): Promise<string[]> {
    const prefix = `${userId}::`;
    const roleIds: string[] = [];
    for (const key of this.assignments) {
      if (key.startsWith(prefix)) {
        roleIds.push(key.slice(prefix.length));
      }
    }
    return roleIds;
  }
}
