import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import { ClientNotFoundError } from '@domain/errors';
import {
  GigaredNotFoundError,
  CicNotFoundError,
  CicAlreadyLinkedError,
} from '@domain/errors/gigared';
import type { CustomerLookup } from './lookups';

/**
 * LinkCustomerToCic (#47 / C2) — binds an existing Gigared CIC to our customer.
 *
 * Ownership guard (the task #47 "CIC_ALREADY_LINKED" path, previously missing):
 *   0. customer must exist locally          → ClientNotFoundError
 *   1. GET /accounts/{cic} (by CIC)         → CicNotFoundError (404) if the partner 404s
 *   2. internal_id NON-empty AND ≠ customer → CicAlreadyLinkedError (409)
 *   3. internal_id == customerId            → idempotent OK (no re-set)
 *   4. internal_id empty                    → setInternalId, then read back by internal_id
 */
export class LinkCustomerToCic {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly customerLookup: CustomerLookup,
  ) {}

  async execute(customerId: string, cic: string): Promise<{ account: GigaredAccount }> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    // 1. Resolve the partner BY CIC. A 404 upstream is a CIC-specific not-found.
    let partner: GigaredAccount;
    try {
      partner = await this.gigared.getAccountByCic(cic);
    } catch (e) {
      if (e instanceof GigaredNotFoundError) throw new CicNotFoundError(cic);
      throw e;
    }

    const linked = partner.internalId ?? '';

    // 3. Already linked to THIS customer → idempotent success, nothing to do.
    if (linked === customerId) return { account: partner };

    // 2. Linked to a DIFFERENT customer → refuse (409), never steal the CIC.
    if (linked !== '') throw new CicAlreadyLinkedError(cic, linked);

    // 4. Free CIC → bind it, then read back the authoritative account by internal_id.
    await this.gigared.setInternalId(cic, customerId);
    const account = await this.gigared.getAccountByInternalId(customerId);
    return { account };
  }
}
