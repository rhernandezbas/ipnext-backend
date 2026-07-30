import type { PortalAccountRepository } from '@domain/ports/PortalAccountRepository';
import type { PortalSessionRepository } from '@domain/ports/PortalSessionRepository';
import { PortalAccountNotFoundError } from '@domain/errors/portal.errors';

export interface DeletePortalAccountAdminInput {
  accountId: string;
}

/**
 * DeletePortalAccountAdmin — customer-portal-api (Fase 3, task 3.2).
 *
 * portal-accounts-admin spec "DELETE elimina la credencial y sus sesiones (el
 * Client queda intacto)". Revokes sessions BEFORE deleting the account —
 * behavior parity between adapters: Prisma cascades the session ROWS away via
 * `onDelete: Cascade` on `PortalSession.account`, but the in-memory adapter
 * does not auto-cascade, so the explicit revoke keeps "access is dead" true on
 * BOTH adapters even though only Prisma also drops the rows. Never touches
 * `Client` — only `PortalAccount`/`PortalSession`.
 */
export class DeletePortalAccountAdmin {
  constructor(
    private readonly accounts: PortalAccountRepository,
    private readonly sessions: PortalSessionRepository,
  ) {}

  async execute(input: DeletePortalAccountAdminInput): Promise<void> {
    const account = await this.accounts.findById(input.accountId);
    if (!account) {
      throw new PortalAccountNotFoundError(input.accountId);
    }

    await this.sessions.revokeAllForAccount(input.accountId);
    await this.accounts.delete(input.accountId);
  }
}
