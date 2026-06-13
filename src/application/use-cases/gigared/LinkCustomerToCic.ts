import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { ClientTvCancellationRepository } from '@domain/ports/ClientTvCancellationRepository';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import {
  GigaredNotFoundError,
  CicNotFoundError,
  CicAlreadyLinkedError,
} from '@domain/errors/gigared';
import type { CustomerLookup, ContractLookup } from './lookups';
import { reconcileTvContractService } from './reconcileTvContractService';

/**
 * Result of LinkCustomerToCic.
 * `local` is present ONLY when a `contractId` was supplied (47f). Otherwise the response is
 * the bare account, byte-for-byte the legacy contract (back-compat).
 *   - 'synced' → the local TV ContractService was reconciled in the contract (router → 200)
 *   - 'failed' → the Gigared link succeeded but the local reconcile threw (router → 207).
 *               The link in Gigared is NEVER reverted (mirror of AddTvService D7).
 */
export interface LinkCustomerResult {
  account: GigaredAccount;
  local?: 'synced' | 'failed';
}

/**
 * LinkCustomerToCic (#47 / C2 + #47f / #72) — binds an existing Gigared CIC to our customer and,
 * when a `contractId` is supplied, reconciles the local TV ContractService slot in THAT contract.
 *
 * #72 — si el link fue exitoso, llama tvCancellation.clearCancelled(customerId) best-effort para
 * limpiar el flag local "TV dada de baja" (el cliente volvió a tener TV). Esto aplica a AMBOS
 * paths: idempotente (el CIC ya estaba vinculado) y la vinculación fresca. Un error en el clear
 * NO aborta la operación ya hecha en Gigared — se logea como warn.
 *
 * Guard order (pinned):
 *   0. customer must exist locally               → ClientNotFoundError
 *   0b. if contractId supplied → it must exist    → ContractNotFoundError (BEFORE any Gigared call)
 *   1. GET /accounts/{cic} (by CIC)              → CicNotFoundError (404) if the partner 404s
 *   2. internal_id NON-empty AND ≠ customer      → CicAlreadyLinkedError (409)
 *   3. internal_id == customerId                 → idempotent OK (no re-set)
 *   4. internal_id empty                         → setInternalId, read back by internal_id
 *   5. if contractId supplied → reconcile the local TV slot (failure → local:'failed', link kept)
 *   6. #72 — clearCancelled best-effort (never aborts the already-done Gigared op)
 *
 * Reconcile deps (csRepo/catalogRepo/contractLookup) are OPTIONAL: when absent (or no contractId),
 * the use case behaves exactly as the legacy link.
 */
export class LinkCustomerToCic {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly customerLookup: CustomerLookup,
    private readonly contractLookup?: ContractLookup,
    private readonly csRepo?: ContractServiceRepository,
    private readonly catalogRepo?: ServiceCatalogRepository,
    private readonly tvCancellation?: ClientTvCancellationRepository,
  ) {}

  async execute(customerId: string, cic: string, contractId?: string): Promise<LinkCustomerResult> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    // 0b. Validate the contract FIRST — never touch Gigared if the target contract is invalid.
    const wantsReconcile = typeof contractId === 'string' && contractId !== '';
    if (wantsReconcile && this.contractLookup) {
      // #47k HIGH: el contrato debe PERTENECER al customer (un contractId ajeno → 404, sin leak).
      const contract = await this.contractLookup.findById(contractId as string);
      if (!contract || contract.clientId !== customerId) throw new ContractNotFoundError(contractId as string);
    }

    // 1. Resolve the partner BY CIC. A 404 upstream is a CIC-specific not-found.
    let partner: GigaredAccount;
    try {
      partner = await this.gigared.getAccountByCic(cic);
    } catch (e) {
      if (e instanceof GigaredNotFoundError) throw new CicNotFoundError(cic);
      throw e;
    }

    const linked = partner.internalId ?? '';

    // 2. Linked to a DIFFERENT customer → refuse (409), never steal the CIC.
    if (linked !== '' && linked !== customerId) throw new CicAlreadyLinkedError(cic, linked);

    // 3 / 4. Already linked to THIS customer → idempotent (no re-set). Free CIC → bind it.
    let account: GigaredAccount;
    if (linked === customerId) {
      account = partner;
    } else {
      await this.gigared.setInternalId(cic, customerId);
      account = await this.gigared.getAccountByInternalId(customerId);
    }

    // #72 — clearCancelled best-effort: el cliente volvió a tener TV (re-vinculación exitosa).
    // Se intenta siempre que el link fue exitoso (paths 3 y 4). Un error aquí NO aborta.
    if (this.tvCancellation) {
      try {
        await this.tvCancellation.clearCancelled(customerId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[gigared] link: TV cancellation flag clear failed (best-effort)', err);
      }
    }

    // 5. No contractId (or reconcile deps missing) → legacy response, untouched.
    if (!wantsReconcile || !this.csRepo || !this.catalogRepo) {
      return { account };
    }

    // Reconcile the local TV slot. Failure here is a partial success — the link stays (207).
    try {
      await reconcileTvContractService({
        gigared: this.gigared,
        csRepo: this.csRepo,
        catalogRepo: this.catalogRepo,
        customerId,
        contractId: contractId as string,
      });
      return { account, local: 'synced' };
    } catch {
      return { account, local: 'failed' };
    }
  }
}
