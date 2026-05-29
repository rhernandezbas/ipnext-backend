import type { RbacRole } from '@domain/entities/rbac';
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';

/**
 * InMemoryRbacUserRoleRepository — test seam for RbacUserRoleRepository.
 *
 * Stores (userId, roleId) pairs in a Set for O(1) idempotent assign/revoke.
 * listForUser returns string[] (role ids) — the port's minimal contract.
 *
 * listRolesForUser requires an injected RbacRoleRepository to resolve role
 * objects. If none is provided it returns [] (backwards-compatible with
 * existing test setups that only need listForUser).
 */
export class InMemoryRbacUserRoleRepository implements RbacUserRoleRepository {
  /** Key format: `${userId}::${roleId}` */
  private readonly assignments = new Set<string>();

  constructor(private readonly roleRepo?: RbacRoleRepository) {}

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

  async listRolesForUser(userId: string): Promise<RbacRole[]> {
    if (!this.roleRepo) return [];
    const roleIds = await this.listForUser(userId);
    const roles: RbacRole[] = [];
    for (const roleId of roleIds) {
      const role = await this.roleRepo.findById(roleId);
      if (role) roles.push(role);
    }
    return roles;
  }
}
