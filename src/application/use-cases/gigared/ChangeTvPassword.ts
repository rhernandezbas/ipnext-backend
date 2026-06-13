import type { GigaredPort } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import {
  GigaredInvalidPasswordError,
  GigaredNotFoundError,
  TvCatalogMissingError,
  TvNotLinkedError,
} from '@domain/errors/gigared';
import { isValidGigaredPassword } from '@infrastructure/security/gigaredPassword';
import { currentTvInternalId } from '@domain/gigared/tvIdentity';
import type { CustomerLookup, ContractLookup } from './lookups';

/**
 * ChangeTvPassword (#65) — changes a Gigared account password and impacts the new value on
 * the local TV ContractService slot (visible to the operator via the dedicated credentials
 * endpoint).
 *
 * #65 fix wave — H1 (SECURITY): the `cic` is NEVER taken from the request body. An operator
 * must not be able to target ANY account's password by sending a foreign cic. The use case
 * resolves the customer's OWN account via getAccountByInternalId(customerId) (mirror of CancelTv)
 * and PATCHes with THAT account's cic. A customer with no linked account → TvNotLinkedError (404).
 *
 * Guard order (pinned):
 *   0. customer must exist                            → ClientNotFoundError (404)
 *   1. password must satisfy the CUA policy [a-z0-9]  → GigaredInvalidPasswordError (400) BEFORE Gigared
 *   2. contract must exist AND belong to the customer → ContractNotFoundError (404) BEFORE Gigared
 *   3. resolve the customer's account (use_internal_id) → TvNotLinkedError (404) on a 404 upstream
 *   4. PATCH /accounts/{account.cic} { password }      → upstream errors propagate (RFC 9457 detail #47g)
 *   5. persist tvPassword on the (contractId, TV) slot — BEST-EFFORT (M5): a failure NEVER throws
 *      after the partner already changed the password; the result carries `persisted: boolean`.
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
    input: { contractId: string; password: string },
  ): Promise<{ password: string; persisted: boolean }> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    // CUA validation up front — the request never reaches Gigared if it cannot pass.
    if (!isValidGigaredPassword(input.password)) throw new GigaredInvalidPasswordError();

    // Ownership: a foreign/absent contract → 404, Gigared never touched.
    const contract = await this.contractLookup.findById(input.contractId);
    if (!contract || contract.clientId !== customerId) throw new ContractNotFoundError(input.contractId);

    // H1 — resolve the customer's OWN account; its cic is the ONLY cic we will ever change.
    // #81 — por el internal_id VIGENTE (seq=0 → id pelado, back-compat).
    const internalId = currentTvInternalId(customerId, customer.tvActivationSeq ?? 0);
    let account;
    try {
      account = await this.gigared.getAccountByInternalId(internalId);
    } catch (e) {
      if (e instanceof GigaredNotFoundError) throw new TvNotLinkedError(customerId);
      throw e;
    }

    await this.gigared.changePassword(account.cic, input.password);

    // M5 — persist the new password on the local TV slot. BEST-EFFORT: the partner already
    // changed the password, so a local failure must NEVER surface as an error. We report it
    // via `persisted` so the FE can warn the operator to write the password down.
    let persisted = false;
    try {
      const tvCatalog = await this.catalogRepo.getByName('TV');
      if (!tvCatalog || !tvCatalog.active) throw new TvCatalogMissingError();
      const existing = await this.csRepo.getByPair(input.contractId, tvCatalog.id);
      if (existing) {
        await this.csRepo.update(existing.id, { tvPassword: input.password });
        persisted = true;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[gigared] changeTvPassword: local persistence failed (best-effort)', err);
      persisted = false;
    }

    return { password: input.password, persisted };
  }
}
