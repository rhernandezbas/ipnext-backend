import type { GigaredPort, GigaredAccount, ListAccountsFilter } from '@domain/ports/GigaredPort';

/** ListGigaredAccounts (#47) — proxies the accounts list, wrapped in { accounts }. */
export class ListGigaredAccounts {
  constructor(private readonly gigared: GigaredPort) {}

  async execute(filter: ListAccountsFilter): Promise<{ accounts: GigaredAccount[] }> {
    const accounts = await this.gigared.listAccounts(filter);
    return { accounts };
  }
}
