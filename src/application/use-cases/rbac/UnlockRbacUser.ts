/**
 * UnlockRbacUser — resets account lockout for an RBAC user.
 *
 * Sets failedLoginCount=0 and lockedUntil=null.
 * Idempotent: safe to call on an already-unlocked user.
 * Gate: requirePerm('admin', 'manage') — enforced at the route level.
 */
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { UserNotFoundError } from '@domain/errors/rbacUser.errors';
import { toRbacUserDto, type RbacUserDto } from '@application/dto/rbacUser.dto';

export class UnlockRbacUser {
  constructor(private readonly users: RbacUserRepository) {}

  async execute(id: string): Promise<RbacUserDto> {
    const existing = await this.users.findById(id);
    if (!existing) throw new UserNotFoundError(id);

    const updated = await this.users.update(id, {
      failedLoginCount: 0,
      lockedUntil: null,
    });

    return toRbacUserDto(updated);
  }
}
