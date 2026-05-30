import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';
import type { PasswordHasher } from '@domain/ports/PasswordHasher';
import {
  AtLeastOneRoleRequiredError,
  RoleNotFoundError,
  LoginAlreadyTakenError,
  EmailAlreadyTakenError,
} from '@domain/errors/rbacUser.errors';
import { validatePassword } from '@domain/services/passwordPolicy';
import type { CreateRbacUserDto, RbacUserWithRolesDto } from '@application/dto/rbacUser.dto';
import { toRbacUserWithRolesDto } from '@application/dto/rbacUser.dto';

export class CreateRbacUser {
  constructor(
    private readonly users: RbacUserRepository,
    private readonly roles: RbacRoleRepository,
    private readonly userRoles: RbacUserRoleRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  async execute(dto: CreateRbacUserDto): Promise<RbacUserWithRolesDto> {
    // 1. Validate password policy (SDD #6a)
    validatePassword(dto.password);

    // 2. Validate roleIds non-empty
    if (!dto.roleIds || dto.roleIds.length === 0) throw new AtLeastOneRoleRequiredError();

    // 3. Validate each roleId exists
    const roleEntities = await Promise.all(
      dto.roleIds.map(async (roleId) => {
        const role = await this.roles.findById(roleId);
        if (!role) throw new RoleNotFoundError(roleId);
        return role;
      }),
    );

    // 4. Check login uniqueness
    const existingByLogin = await this.users.findByLogin(dto.login);
    if (existingByLogin) throw new LoginAlreadyTakenError(dto.login);

    // 5. Check email uniqueness
    const existingByEmail = await this.users.findByEmail(dto.email);
    if (existingByEmail) throw new EmailAlreadyTakenError(dto.email);

    // 6. Hash password
    const passwordHash = await this.hasher.hash(dto.password);

    // 7. Create user
    const user = await this.users.create({
      name: dto.name,
      email: dto.email,
      login: dto.login,
      passwordHash,
      status: dto.status ?? 'active',
    });

    // 8. Assign roles
    await Promise.all(dto.roleIds.map(roleId => this.userRoles.assign(user.id, roleId)));

    // 9. Return DTO with roles
    return toRbacUserWithRolesDto(user, roleEntities);
  }
}
