import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import { ClientNotFoundError } from '@domain/errors';
import type { CustomerLookup } from './lookups';

/**
 * RegisterGigaredAccount (#47) — registers a brand-new Gigared account for a CIC,
 * activates it, binds internal_id = customerId, then returns the account.
 * The password is TRANSIT-ONLY: it is forwarded to Gigared and never persisted or logged.
 */
export class RegisterGigaredAccount {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly customerLookup: CustomerLookup,
  ) {}

  async execute(
    customerId: string,
    input: {
      firstName: string;
      lastName: string;
      email: string;
      cic: string;
      password: string;
      sendActivationEmail: boolean;
    },
  ): Promise<{ account: GigaredAccount }> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    await this.gigared.register(input);
    await this.gigared.activate({ cic: input.cic, email: input.email });
    await this.gigared.setInternalId(input.cic, customerId);
    const account = await this.gigared.getAccountByInternalId(customerId);
    return { account };
  }
}
