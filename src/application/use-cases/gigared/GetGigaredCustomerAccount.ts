import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import { GigaredNotFoundError } from '@domain/errors/gigared';
import { ClientNotFoundError } from '@domain/errors';
import type { CustomerLookup } from './lookups';

/**
 * GetGigaredCustomerAccount (#47) — fetch the Gigared account bound to this customer
 * (internal_id = customerId). A Gigared 404 is NOT an error here: it means "not linked",
 * mapped to { linked: false, account: null } (the FE shows the link/register forms).
 */
export class GetGigaredCustomerAccount {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly customerLookup: CustomerLookup,
  ) {}

  async execute(customerId: string): Promise<{ linked: boolean; account: GigaredAccount | null }> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    try {
      const account = await this.gigared.getAccountByInternalId(customerId);
      return { linked: true, account };
    } catch (e) {
      if (e instanceof GigaredNotFoundError) return { linked: false, account: null };
      throw e;
    }
  }
}
