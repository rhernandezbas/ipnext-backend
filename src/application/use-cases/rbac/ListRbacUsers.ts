import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';
import { toRbacUserWithRolesDto, type RbacUserWithRolesDto } from '@application/dto/rbacUser.dto';

export class ListRbacUsers {
  constructor(
    private readonly users: RbacUserRepository,
    private readonly userRoles: RbacUserRoleRepository,
    private readonly roles: RbacRoleRepository,
  ) {}

  async execute(): Promise<RbacUserWithRolesDto[]> {
    const allUsers = await this.users.list();
    const result: RbacUserWithRolesDto[] = [];

    for (const user of allUsers) {
      const roleIds = await this.userRoles.listForUser(user.id);
      const roleEntities = await Promise.all(roleIds.map(id => this.roles.findById(id)));
      const validRoles = roleEntities.filter((r): r is NonNullable<typeof r> => r !== null);
      result.push(toRbacUserWithRolesDto(user, validRoles));
    }

    return result;
  }
}
