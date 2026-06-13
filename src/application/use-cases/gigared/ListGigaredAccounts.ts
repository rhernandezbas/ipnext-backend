import type { GigaredPort, GigaredAccount, ListAccountsFilter } from '@domain/ports/GigaredPort';

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

/** ListGigaredAccounts (#47) — proxies the accounts list, wrapped in { accounts }. */
export class ListGigaredAccounts {
  constructor(private readonly gigared: GigaredPort) {}

  async execute(filter: ListAccountsFilter): Promise<{ accounts: GigaredAccount[] }> {
    const accounts = await this.gigared.listAccounts(filter);
    return { accounts: accounts.map(reapplyClientId) };
  }
}
