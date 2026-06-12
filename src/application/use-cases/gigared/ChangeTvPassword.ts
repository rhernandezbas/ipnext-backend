import type { GigaredPort } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { GigaredInvalidPasswordError, TvCatalogMissingError } from '@domain/errors/gigared';
import { isValidGigaredPassword } from '@infrastructure/security/gigaredPassword';
import type { CustomerLookup, ContractLookup } from './lookups';

/**
 * ChangeTvPassword (#65) — changes a Gigared account password and impacts the new value on
 * the local TV ContractService slot (visible to the operator).
 *
 * Guard order (pinned):
 *   0. customer must exist                          → ClientNotFoundError (404)
 *   1. password must satisfy the CUA policy [a-z0-9] → GigaredInvalidPasswordError (400) BEFORE Gigared
 *   2. contract must exist AND belong to the customer→ ContractNotFoundError (404) BEFORE Gigared
 *   3. PATCH /accounts/{cic} { password }            → upstream errors propagate (RFC 9457 detail #47g)
 *   4. persist tvPassword on the (contractId, TV) slot when present (best-effort if absent)
 */
export class ChangeTvPassword {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly customerLookup: CustomerLookup,
    private readonly contractLookup: ContractLookup,
    private readonly csRepo: ContractServiceRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
  ) {}

  async execute(
    customerId: string,
    input: { cic: string; contractId: string; password: string },
  ): Promise<{ password: string }> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    // CUA validation up front — the request never reaches Gigared if it cannot pass.
    if (!isValidGigaredPassword(input.password)) throw new GigaredInvalidPasswordError();

    // Ownership: a foreign/absent contract → 404, Gigared never touched.
    const contract = await this.contractLookup.findById(input.contractId);
    if (!contract || contract.clientId !== customerId) throw new ContractNotFoundError(input.contractId);

    await this.gigared.changePassword(input.cic, input.password);

    // Persist the new password on the local TV slot (ownership intact — notes untouched).
    const tvCatalog = await this.catalogRepo.getByName('TV');
    if (!tvCatalog || !tvCatalog.active) throw new TvCatalogMissingError();
    const existing = await this.csRepo.getByPair(input.contractId, tvCatalog.id);
    if (existing) {
      await this.csRepo.update(existing.id, { tvPassword: input.password });
    }

    return { password: input.password };
  }
}
