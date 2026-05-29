import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';
import {
  UserNotFoundError,
  RoleNotFoundError,
  CannotRemoveLastSuperAdminError,
} from '@domain/errors/rbacUser.errors';

export class RemoveRoleFromUser {
  constructor(
    private readonly users: RbacUserRepository,
    private readonly roles: RbacRoleRepository,
    private readonly userRoles: RbacUserRoleRepository,
  ) {}

  async execute(userId: string, roleId: string): Promise<void> {
    // 1. Verify user exists
    const user = await this.users.findById(userId);
    if (!user) throw new UserNotFoundError(userId);

    // 2. Verify role exists
    const role = await this.roles.findById(roleId);
    if (!role) throw new RoleNotFoundError(roleId);

    // 3. Last-super_admin guard (only if the role being removed is super_admin)
    if (role.code === 'super_admin') {
      const count = await this.users.countUsersWithRoleCode('super_admin');
      if (count <= 1) throw new CannotRemoveLastSuperAdminError();
    }

    // 4. Revoke (idempotent — no error if not assigned)
    await this.userRoles.revoke(userId, roleId);
  }
}
