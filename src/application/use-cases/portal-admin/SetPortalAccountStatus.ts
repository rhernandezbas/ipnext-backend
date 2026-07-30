import type { PortalAccountRepository } from '@domain/ports/PortalAccountRepository';
import type { PortalSessionRepository } from '@domain/ports/PortalSessionRepository';
import { PortalAccountNotFoundError } from '@domain/errors/portal.errors';
import type { PortalAccountAdminDto } from '@application/dto/portal/portalAccountAdmin.dto';
import { toPortalAccountAdminDto } from '@application/dto/portal/portalAccountAdmin.dto';

export interface SetPortalAccountStatusInput {
  accountId: string;
  status: 'active' | 'disabled';
}

/**
 * SetPortalAccountStatus — customer-portal-api (Fase 3, task 3.2).
 *
 * portal-accounts-admin spec "Deshabilitar corta el acceso ya emitido": setting
 * `disabled` revokes every active session — the account's `status !== 'active'`
 * check ALREADY blocks new logins (see `PortalLogin`) and `portalAuthMiddleware`
 * ALREADY re-checks status per-request, but a session issued before the disable
 * must stop rotating immediately, not just at its next natural expiry. `active`
 * has nothing to revoke (a disabled account carries no live sessions by the
 * time it got there — either it never had one, or the disable already killed
 * them) — no-op on sessions either way.
 */
export class SetPortalAccountStatus {
  constructor(
    private readonly accounts: PortalAccountRepository,
    private readonly sessions: PortalSessionRepository,
  ) {}

  async execute(input: SetPortalAccountStatusInput): Promise<PortalAccountAdminDto> {
    const account = await this.accounts.findById(input.accountId);
    if (!account) {
      throw new PortalAccountNotFoundError(input.accountId);
    }

    const updated = await this.accounts.update(input.accountId, { status: input.status });

    if (input.status === 'disabled') {
      await this.sessions.revokeAllForAccount(input.accountId);
    }

    return toPortalAccountAdminDto(updated);
  }
}
