import type { GigaredPort } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { AddTvServiceResult } from '@application/dto/gigared.dto';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { GigaredRejectedError, TvCatalogMissingError } from '@domain/errors/gigared';
import type { CustomerLookup, ContractLookup } from './lookups';
import { reconcileTvContractService } from './reconcileTvContractService';

/**
 * AddTvService (#47) — add a TV service in Gigared, then reconcile the local slot.
 *
 * Guard order (pinned): customer 404 → contract 404 → active 'TV' catalog (422) →
 *   gigared.addService (1º Gigared). If Gigared rejects BUT the account already has the
 *   serviceId, that is idempotent success — continue (D7). Otherwise rethrow.
 *   → reconcile local ContractService (D6, 2º local). If reconcile throws,
 *   the result is { gigared:'ok', local:'failed' } (router → 207, retry = re-POST).
 */
export class AddTvService {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly csRepo: ContractServiceRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly contractLookup: ContractLookup,
    private readonly customerLookup: CustomerLookup,
  ) {}

  async execute(
    customerId: string,
    { contractId, serviceId }: { contractId: string; serviceId: string },
  ): Promise<AddTvServiceResult> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    // #47k HIGH: el contrato debe PERTENECER al customer (un contractId ajeno → 404, sin leak).
    const contract = await this.contractLookup.findById(contractId);
    if (!contract || contract.clientId !== customerId) throw new ContractNotFoundError(contractId);

    const tvCatalog = await this.catalogRepo.getByName('TV');
    if (!tvCatalog || !tvCatalog.active) throw new TvCatalogMissingError();

    // 1º Gigared
    try {
      await this.gigared.addService(customerId, serviceId);
    } catch (e) {
      if (e instanceof GigaredRejectedError) {
        // D7: if the account already carries this service, the rejection is a no-op — continue.
        const account = await this.gigared.getAccountByInternalId(customerId);
        const alreadyHas = account.services.some((s) => s.id === serviceId);
        if (!alreadyHas) throw e;
      } else {
        throw e;
      }
    }

    // 2º local reconcile — failure here is a partial success (207), never reverts Gigared.
    try {
      const { contractServiceId } = await reconcileTvContractService({
        gigared: this.gigared,
        csRepo: this.csRepo,
        catalogRepo: this.catalogRepo,
        customerId,
        contractId,
      });
      const result: AddTvServiceResult = { gigared: 'ok', local: 'ok' };
      if (contractServiceId) result.contractServiceId = contractServiceId;
      return result;
    } catch (e) {
      return { gigared: 'ok', local: 'failed', localError: (e as Error).message };
    }
  }
}
