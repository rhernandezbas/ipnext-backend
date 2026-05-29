import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';
import { UserNotFoundError } from '@domain/errors/rbacUser.errors';
import { toRbacRoleDto, type RbacRoleDto } from '@application/dto/rbacUser.dto';

export class ListRolesForUser {
  constructor(
    private readonly users: RbacUserRepository,
    private readonly userRoles: RbacUserRoleRepository,
    private readonly roles: RbacRoleRepository,
  ) {}

  async execute(userId: string): Promise<RbacRoleDto[]> {
    const user = await this.users.findById(userId);
    if (!user) throw new UserNotFoundError(userId);

    const roleIds = await this.userRoles.listForUser(userId);
    const roleEntities = await Promise.all(roleIds.map(id => this.roles.findById(id)));
    const validRoles = roleEntities.filter((r): r is NonNullable<typeof r> => r !== null);

    return validRoles.map(toRbacRoleDto);
  }
}
