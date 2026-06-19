import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { PasswordHasher } from '@domain/ports/PasswordHasher';
import {
  UserNotFoundError,
  PasswordTooShortError,
  LoginAlreadyTakenError,
} from '@domain/errors/rbacUser.errors';
import type { UpdateRbacUserDto, RbacUserDto } from '@application/dto/rbacUser.dto';
import { toRbacUserDto } from '@application/dto/rbacUser.dto';

export class UpdateRbacUser {
  constructor(
    private readonly users: RbacUserRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  async execute(id: string, dto: UpdateRbacUserDto): Promise<RbacUserDto> {
    // Verify user exists
    const existing = await this.users.findById(id);
    if (!existing) throw new UserNotFoundError(id);

    const patch: Parameters<typeof this.users.update>[1] = {};

    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.email !== undefined) patch.email = dto.email;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.grVendedorName !== undefined) patch.grVendedorName = dto.grVendedorName;

    // Login update: check for conflicts
    if (dto.login !== undefined && dto.login !== existing.login) {
      const conflict = await this.users.findByLogin(dto.login);
      if (conflict) throw new LoginAlreadyTakenError(dto.login);
      patch.login = dto.login;
    }

    // Password: absent or empty string → skip; non-empty → validate + hash
    if (dto.password !== undefined && dto.password !== '') {
      if (dto.password.length < 8) throw new PasswordTooShortError();
      patch.passwordHash = await this.hasher.hash(dto.password);
    }

    const updated = await this.users.update(id, patch);
    return toRbacUserDto(updated);
  }
}
