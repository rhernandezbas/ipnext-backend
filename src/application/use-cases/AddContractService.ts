import { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';
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

export interface ActorInput {
  actorId:   string | null;
  actorName: string;
}

export class AddContractService {
  constructor(
    private readonly csRepo: ContractServiceRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly contractLookup: ContractLookup,
    /** #110 — optional: when present, registers an 'activated' event (best-effort). */
    private readonly eventRepo?: ContractServiceEventRepository,
  ) {}

  async execute(
    contractId: string,
    data: { serviceCatalogId: string; notes?: string | null },
    actor?: ActorInput,
  ): Promise<ContractServiceView> {
    // Guard order (pinned): 404 contract → 404 catalog → 422 inactive → 409 duplicate.
    const contract = await this.contractLookup.findById(contractId);
    if (!contract) throw new ContractNotFoundError(contractId);

    const catalog = await this.catalogRepo.getById(data.serviceCatalogId);
    if (!catalog) throw new ServiceCatalogNotFoundError(data.serviceCatalogId);
    if (!catalog.active) throw new ServiceCatalogInactiveError(data.serviceCatalogId);

    const existing = await this.csRepo.getByPair(contractId, data.serviceCatalogId);
    if (existing) throw new ContractServiceDuplicateError();

    const result = await this.csRepo.add({
      contractId,
      serviceCatalogId: data.serviceCatalogId,
      notes: data.notes ?? null,
    });

    // #110 — best-effort event registration (patrón RegisterGigaredAccount.ts:178-194)
    if (this.eventRepo) {
      try {
        await this.eventRepo.record({
          contractId,
          serviceCatalogId: data.serviceCatalogId,
          eventType:        'activated',
          actorId:          actor?.actorId ?? null,
          actorName:        actor?.actorName ?? '',
        });
      } catch (err) {
        console.warn('[AddContractService] Failed to record activated event (best-effort):', err);
      }
    }

    return result;
  }
}
