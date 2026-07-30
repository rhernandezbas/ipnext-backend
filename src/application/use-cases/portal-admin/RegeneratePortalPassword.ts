import type { PortalAccountRepository } from '@domain/ports/PortalAccountRepository';
import type { PortalSessionRepository } from '@domain/ports/PortalSessionRepository';
import type { PasswordHasher } from '@domain/ports/PasswordHasher';
import { PortalAccountNotFoundError } from '@domain/errors/portal.errors';
import { generatePortalPassword } from '@domain/services/generatePortalPassword';
import type { RegeneratePortalPasswordResponseDto } from '@application/dto/portal/portalAccountAdmin.dto';
import { toPortalAccountAdminDto } from '@application/dto/portal/portalAccountAdmin.dto';

export interface RegeneratePortalPasswordInput {
  accountId: string;
}

/**
 * RegeneratePortalPassword — customer-portal-api (Fase 3, task 3.2).
 *
 * portal-accounts-admin spec "Regenerar password": revokes EVERY active
 * session of the account BEFORE issuing the new hash (same "revoke, then
 * grant" order as `SetPortalAccountStatus`'s disable path — the old password
 * and every session tied to it must be dead before the new one exists), marks
 * `mustChangePassword = true`, and shows the plain-text password exactly once.
 */
export class RegeneratePortalPassword {
  constructor(
    private readonly accounts: PortalAccountRepository,
    private readonly sessions: PortalSessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly generatePassword: () => string = generatePortalPassword,
  ) {}

  async execute(input: RegeneratePortalPasswordInput): Promise<RegeneratePortalPasswordResponseDto> {
    const account = await this.accounts.findById(input.accountId);
    if (!account) {
      throw new PortalAccountNotFoundError(input.accountId);
    }

    await this.sessions.revokeAllForAccount(input.accountId);

    const password = this.generatePassword();
    const passwordHash = await this.hasher.hash(password);
    const updated = await this.accounts.update(input.accountId, { passwordHash, mustChangePassword: true });

    return { ...toPortalAccountAdminDto(updated), password };
  }
}
