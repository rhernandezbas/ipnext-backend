import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';
import { UserNotFoundError } from '@domain/errors/rbacUser.errors';
import { toRbacUserWithRolesDto, type RbacUserWithRolesDto } from '@application/dto/rbacUser.dto';

export class GetRbacUser {
  constructor(
    private readonly users: RbacUserRepository,
    private readonly userRoles: RbacUserRoleRepository,
    private readonly roles: RbacRoleRepository,
  ) {}

  async execute(id: string): Promise<RbacUserWithRolesDto> {
    const user = await this.users.findById(id);
    if (!user) throw new UserNotFoundError(id);

    const roleIds = await this.userRoles.listForUser(id);
    const roleEntities = await Promise.all(roleIds.map(rid => this.roles.findById(rid)));
    const validRoles = roleEntities.filter((r): r is NonNullable<typeof r> => r !== null);

    return toRbacUserWithRolesDto(user, validRoles);
  }
}
