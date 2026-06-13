import type { GigaredPort } from '@domain/ports/GigaredPort';
import { ClientNotFoundError } from '@domain/errors';
import { currentTvInternalId } from '@domain/gigared/tvIdentity';
import type { CustomerLookup } from './lookups';

/**
 * SetOttStatus (#47) — enable/disable OTT for a customer's Gigared account (by internal_id).
 * A not-linked customer surfaces as GigaredNotFoundError from the port (router → 404).
 */
export class SetOttStatus {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly customerLookup: CustomerLookup,
  ) {}

  async execute(customerId: string, enabled: boolean): Promise<void> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);
    // #81 — internal_id vigente (seq=0 → id pelado, back-compat).
    const internalId = currentTvInternalId(customerId, customer.tvActivationSeq ?? 0);
    await this.gigared.setOtt(internalId, enabled);
  }
}
