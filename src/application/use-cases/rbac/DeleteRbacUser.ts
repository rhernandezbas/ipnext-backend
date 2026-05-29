import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';
import {
  UserNotFoundError,
  CannotDeleteSelfError,
  CannotRemoveLastSuperAdminError,
} from '@domain/errors/rbacUser.errors';

export class DeleteRbacUser {
  constructor(
    private readonly users: RbacUserRepository,
    private readonly userRoles: RbacUserRoleRepository,
    private readonly roles: RbacRoleRepository,
  ) {}

  async execute(id: string, requestingUserId: string): Promise<void> {
    // 1. Self-delete guard
    if (id === requestingUserId) throw new CannotDeleteSelfError();

    // 2. Verify target exists
    const target = await this.users.findById(id);
    if (!target) throw new UserNotFoundError(id);

    // 3. Last-super_admin guard
    const roleIds = await this.userRoles.listForUser(id);
    const roleEntities = await Promise.all(roleIds.map(rid => this.roles.findById(rid)));
    const hasSuperAdmin = roleEntities.some(r => r?.code === 'super_admin');

    if (hasSuperAdmin) {
      const count = await this.users.countUsersWithRoleCode('super_admin');
      if (count <= 1) throw new CannotRemoveLastSuperAdminError();
    }

    // 4. Delete (Prisma cascades pivot rows via ON DELETE CASCADE)
    await this.users.delete(id);
  }
}
