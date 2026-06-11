import { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ContractServiceView } from '@domain/entities/contract-service';
import {
  ContractNotFoundError,
  ServiceCatalogNotFoundError,
  ServiceCatalogInactiveError,
  ContractServiceDuplicateError,
} from '@domain/errors/contractServices';

/** Existence-only lookup, injected (precedent: prismaClientLookup('Contract', id)). */
export interface ContractLookup {
  findById(id: string): Promise<{ id: string } | null>;
}

export class AddContractService {
  constructor(
    private readonly csRepo: ContractServiceRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly contractLookup: ContractLookup,
  ) {}

  async execute(contractId: string, data: { serviceCatalogId: string; notes?: string | null }): Promise<ContractServiceView> {
    // Guard order (pinned): 404 contract → 404 catalog → 422 inactive → 409 duplicate.
    const contract = await this.contractLookup.findById(contractId);
    if (!contract) throw new ContractNotFoundError(contractId);

    const catalog = await this.catalogRepo.getById(data.serviceCatalogId);
    if (!catalog) throw new ServiceCatalogNotFoundError(data.serviceCatalogId);
    if (!catalog.active) throw new ServiceCatalogInactiveError(data.serviceCatalogId);

    const existing = await this.csRepo.getByPair(contractId, data.serviceCatalogId);
    if (existing) throw new ContractServiceDuplicateError();

    return this.csRepo.add({ contractId, serviceCatalogId: data.serviceCatalogId, notes: data.notes ?? null });
  }
}
