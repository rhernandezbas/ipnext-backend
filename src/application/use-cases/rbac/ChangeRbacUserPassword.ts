import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { PasswordHasher } from '@domain/ports/PasswordHasher';
import {
  UserNotFoundError,
  PasswordTooShortError,
  InvalidOldPasswordError,
} from '@domain/errors/rbacUser.errors';
import type { ChangeRbacUserPasswordDto } from '@application/dto/rbacUser.dto';

export class ChangeRbacUserPassword {
  constructor(
    private readonly users: RbacUserRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  async execute(
    targetId: string,
    dto: ChangeRbacUserPasswordDto,
    isAdminManaged: boolean,
  ): Promise<void> {
    // 1. Validate new password length
    if (dto.newPassword.length < 8) throw new PasswordTooShortError();

    // 2. Find user (including passwordHash for self-change verification)
    // We need findByLogin or a way to get passwordHash.
    // findById only returns RbacUser (no hash). We use findById first for existence check,
    // then if self-change, we need the hash. Use update to get the stored record.
    const user = await this.users.findById(targetId);
    if (!user) throw new UserNotFoundError(targetId);

    // 3. For self-change: verify old password
    if (!isAdminManaged) {
      if (!dto.oldPassword) throw new InvalidOldPasswordError();

      // We need the stored hash. findByLogin gives us the hash, but we only have id.
      // Use update with a no-op to get the entity, but that's circular.
      // Instead, use findByLogin with the known login.
      const userWithHash = await this.users.findByLogin(user.login);
      if (!userWithHash) throw new UserNotFoundError(targetId);

      const isValid = await this.hasher.compare(dto.oldPassword, userWithHash.passwordHash);
      if (!isValid) throw new InvalidOldPasswordError();
    }

    // 4. Hash new password and update
    const newHash = await this.hasher.hash(dto.newPassword);
    await this.users.update(targetId, { passwordHash: newHash });
  }
}
