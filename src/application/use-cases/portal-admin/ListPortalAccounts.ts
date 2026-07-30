import type { PortalAccountRepository } from '@domain/ports/PortalAccountRepository';
import type { ClientPortalLookup } from '@domain/ports/ClientPortalLookup';
import type { PaginatedQuery } from '@application/dto/pagination';
import type { PortalAccountListResponseDto } from '@application/dto/portal/portalAccountAdmin.dto';

/**
 * ListPortalAccounts — customer-portal-api (Fase 3, task 3.2).
 *
 * portal-accounts-admin spec "GET .../ lista con el nombre del cliente, dni,
 * status, lastLoginAt, paginado". The repository returns bare `PortalAccount`
 * rows (no join); this use case batch-resolves client names via
 * `ClientPortalLookup.findNamesByIds` (ONE call for the whole page, not N+1)
 * and stitches the DTO together. A client that no longer resolves (shouldn't
 * happen — FK — but defensive) falls back to an empty name rather than
 * dropping the row.
 */
export class ListPortalAccounts {
  constructor(
    private readonly accounts: PortalAccountRepository,
    private readonly clients: ClientPortalLookup,
  ) {}

  async execute(query: PaginatedQuery): Promise<PortalAccountListResponseDto> {
    const page = await this.accounts.list(query);
    const names = await this.clients.findNamesByIds(page.data.map((a) => a.clientId));
    const nameById = new Map(names.map((n) => [n.id, n.name]));

    return {
      data: page.data.map((account) => ({
        id: account.id,
        clientId: account.clientId,
        clientName: nameById.get(account.clientId) ?? '',
        dni: account.dni,
        status: account.status,
        lastLoginAt: account.lastLoginAt,
      })),
      total: page.total,
      page: page.page,
      limit: page.limit,
    };
  }
}
