import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';
import {
  UserNotFoundError,
  RoleNotFoundError,
  AtLeastOneRoleRequiredError,
  CannotRemoveLastSuperAdminError,
} from '@domain/errors/rbacUser.errors';
import { toRbacRoleDto, type RbacRoleDto } from '@application/dto/rbacUser.dto';

export class SetRolesForUser {
  constructor(
    private readonly users: RbacUserRepository,
    private readonly roles: RbacRoleRepository,
    private readonly userRoles: RbacUserRoleRepository,
  ) {}

  /**
   * Bulk-replaces the user's role set.
   * Diff algorithm: load current → compute toAdd/toRemove → guard → apply delta.
   *
   * Known concurrency limitation: last-write-wins race condition if two admins
   * edit the same user simultaneously (per spec R10.6). Accepted as YAGNI.
   */
  async execute(userId: string, roleIds: string[]): Promise<RbacRoleDto[]> {
    // 1. Verify user exists
    const user = await this.users.findById(userId);
    if (!user) throw new UserNotFoundError(userId);

    // 2. Validate non-empty
    if (!roleIds || roleIds.length === 0) throw new AtLeastOneRoleRequiredError();

    // 3. Validate all roleIds exist (throw on first unknown)
    const newRoleEntities = await Promise.all(
      roleIds.map(async (roleId) => {
        const role = await this.roles.findById(roleId);
        if (!role) throw new RoleNotFoundError(roleId);
        return role;
      }),
    );

    // 4. Compute diff
    const currentIds = await this.userRoles.listForUser(userId);
    const currentSet = new Set(currentIds);
    const newSet = new Set(roleIds);

    const toRemove = currentIds.filter(id => !newSet.has(id));
    const toAdd = roleIds.filter(id => !currentSet.has(id));

    // 5. Last-super_admin guard: check if removing any current role would wipe out super_admins
    for (const removeId of toRemove) {
      const role = await this.roles.findById(removeId);
      if (role?.code === 'super_admin') {
        const count = await this.users.countUsersWithRoleCode('super_admin');
        if (count <= 1) throw new CannotRemoveLastSuperAdminError();
      }
    }

    // 6. Apply delta
    for (const id of toRemove) {
      await this.userRoles.revoke(userId, id);
    }
    for (const id of toAdd) {
      await this.userRoles.assign(userId, id);
    }

    // 7. Return final role DTOs (the new set, resolved)
    return newRoleEntities.map(toRbacRoleDto);
  }
}
