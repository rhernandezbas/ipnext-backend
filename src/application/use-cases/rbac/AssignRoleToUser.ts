import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';
import { UserNotFoundError, RoleNotFoundError } from '@domain/errors/rbacUser.errors';

export class AssignRoleToUser {
  constructor(
    private readonly users: RbacUserRepository,
    private readonly roles: RbacRoleRepository,
    private readonly userRoles: RbacUserRoleRepository,
  ) {}

  async execute(userId: string, roleId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new UserNotFoundError(userId);

    const role = await this.roles.findById(roleId);
    if (!role) throw new RoleNotFoundError(roleId);

    // Idempotent — RbacUserRoleRepository.assign uses upsert semantics
    await this.userRoles.assign(userId, roleId);
  }
}
