import type { GigaredPort, GigaredAccount, ListAccountsFilter } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { cicFromNotes } from './reconcileTvContractService';

/**
 * #3 — Re-derive clientId authoritatively at the application layer.
 * The adapter enriches clientId as a convenience, but the application layer is the
 * source of truth for the wire contract — don't trust the adapter's enrichment blindly.
 */
function reapplyClientId(account: GigaredAccount): GigaredAccount {
  return {
    ...account,
    clientId: account.internalId ? account.internalId.replace(/-\d+$/, '') : null,
  };
}

/**
 * ListGigaredAccounts (#47) — proxies the accounts list, wrapped in { accounts }.
 *
 * gigared-tv-identity-hardening (D4/B4) — local-first owner resolution: the partner's
 * `internal_id` alias is append-only and keeps reporting the ORIGINAL owner forever, even
 * after a successful `TransferTvToCustomer` (Centeno/Vacherand incident). `csRepo` +
 * `catalogRepo` are OPTIONAL — when BOTH are present, a managed local `ContractService` row
 * for the account's `cic` is the AUTHORITATIVE source of `clientId`; without a local match (or
 * without either dep, or without a resolvable TV catalog), it falls back to the alias-derived
 * value (`reapplyClientId`, byte-identical to the legacy behavior). ONE batch query for the
 * WHOLE page — N+1 FORBIDDEN, this powers the operators' `GET /api/gigared/accounts`.
 */
export class ListGigaredAccounts {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly csRepo?: ContractServiceRepository,
    private readonly catalogRepo?: ServiceCatalogRepository,
  ) {}

  async execute(filter: ListAccountsFilter): Promise<{ accounts: GigaredAccount[] }> {
    const accounts = await this.gigared.listAccounts(filter);
    const aliased = accounts.map(reapplyClientId);

    // Fail-open to alias-only: deps not injected (legacy caller) — byte-identical behavior.
    if (!this.csRepo || !this.catalogRepo) {
      return { accounts: aliased };
    }

    const tvCatalog = await this.catalogRepo.getByName('TV');
    // Fail-open to alias-only: no resolvable TV catalog — never block the list on this.
    if (!tvCatalog || !tvCatalog.active) {
      return { accounts: aliased };
    }

    const cics = accounts.map((a) => a.cic).filter((c): c is string => !!c);
    const rows = cics.length > 0 ? await this.csRepo.findActiveTvOwnersByCics(tvCatalog.id, cics) : [];

    // First row wins (rows arrive oldest-first, createdAt asc — both adapters pin that order).
    const ownerByCic = new Map<string, string>();
    for (const row of rows) {
      const cic = cicFromNotes(row.notes);
      if (cic && !ownerByCic.has(cic)) ownerByCic.set(cic, row.clientId);
    }

    return {
      accounts: aliased.map((account, i) => {
        const cic = accounts[i]!.cic;
        const localClientId = cic ? ownerByCic.get(cic) : undefined;
        return localClientId !== undefined ? { ...account, clientId: localClientId } : account;
      }),
    };
  }
}
