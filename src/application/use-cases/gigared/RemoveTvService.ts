import type { GigaredPort } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { RemoveTvServiceResult } from '@application/dto/gigared.dto';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import type { CustomerLookup, ContractLookup } from './lookups';
import { reconcileTvContractService } from './reconcileTvContractService';

/**
 * RemoveTvService (#47) — mirror of AddTvService: remove the service in Gigared, then
 * reconcile the local slot. If the customer ends up with no Gigared services, reconcile
 * deletes the local ContractService (idempotent); otherwise it refreshes the notes.
 * Reconcile failure → { gigared:'ok', local:'failed' } (router → 207).
 */
export class RemoveTvService {
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
  ): Promise<RemoveTvServiceResult> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    const contract = await this.contractLookup.findById(contractId);
    if (!contract) throw new ContractNotFoundError(contractId);

    await this.gigared.removeService(customerId, serviceId);

    try {
      const { contractServiceId } = await reconcileTvContractService({
        gigared: this.gigared,
        csRepo: this.csRepo,
        catalogRepo: this.catalogRepo,
        customerId,
        contractId,
      });
      const result: RemoveTvServiceResult = { gigared: 'ok', local: 'ok' };
      if (contractServiceId) result.contractServiceId = contractServiceId;
      return result;
    } catch (e) {
      return { gigared: 'ok', local: 'failed', localError: (e as Error).message };
    }
  }
}
