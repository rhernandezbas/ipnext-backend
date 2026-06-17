import type { GigaredPort } from "@domain/ports/GigaredPort";
import type { ContractServiceRepository } from "@domain/ports/ContractServiceRepository";
import type { ServiceCatalogRepository } from "@domain/ports/ServiceCatalogRepository";
import type { TvActivationEventRepository } from "@domain/ports/TvActivationEventRepository";
import type { AddTvServiceResult } from "@application/dto/gigared.dto";
import { ClientNotFoundError } from "@domain/errors";
import { ContractNotFoundError } from "@domain/errors/contractServices";
import { GigaredRejectedError, TvCatalogMissingError } from "@domain/errors/gigared";
import { currentTvInternalId } from "@domain/gigared/tvIdentity";
import type { CustomerLookup, ContractLookup } from "./lookups";
import { reconcileTvContractService } from "./reconcileTvContractService";

/**
 * AddTvService (#47) -- add a TV service in Gigared, then reconcile the local slot.
 *
 * Guard order (pinned): customer 404 -> contract 404 -> active 'TV' catalog (422) ->
 *   gigared.addService (1 Gigared). If Gigared rejects BUT the account already has the
 *   serviceId, that is idempotent success -- continue (D7). Otherwise rethrow.
 *   -> reconcile local ContractService (D6, 2 local). If reconcile throws,
 *   the result is { gigared:'ok', local:'failed' } (router -> 207, retry = re-POST).
 *
 * #131 PARTE B: accepts optional tvEventRepo + actor so reconcile can record a 'reactivacion'
 * event when it reactivates an existing inactive row (best-effort, does not abort on failure).
 */
export class AddTvService {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly csRepo: ContractServiceRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly contractLookup: ContractLookup,
    private readonly customerLookup: CustomerLookup,
    /** #131 PARTE B -- optional; when provided, records 'reactivacion' on row reuse. */
    private readonly tvEventRepo?: TvActivationEventRepository,
  ) {}

  async execute(
    customerId: string,
    { contractId, serviceId, actorId, actorName }: { contractId: string; serviceId: string; actorId?: string | null; actorName?: string },
  ): Promise<AddTvServiceResult> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    // #47k HIGH: el contrato debe PERTENECER al customer (un contractId ajeno -> 404, sin leak).
    const contract = await this.contractLookup.findById(contractId);
    if (!contract || contract.clientId !== customerId) throw new ContractNotFoundError(contractId);

    const tvCatalog = await this.catalogRepo.getByName('TV');
    if (!tvCatalog || !tvCatalog.active) throw new TvCatalogMissingError();

    // #81 -- internal_id vigente (seq=0 -> id pelado, back-compat).
    const internalId = currentTvInternalId(customerId, customer.tvActivationSeq ?? 0);

    // 1 Gigared
    try {
      await this.gigared.addService(internalId, serviceId);
    } catch (e) {
      if (e instanceof GigaredRejectedError) {
        // D7: if the account already carries this service, the rejection is a no-op -- continue.
        const account = await this.gigared.getAccountByInternalId(internalId);
        const alreadyHas = account.services.some((s) => s.id === serviceId);
        if (!alreadyHas) throw e;
      } else {
        throw e;
      }
    }

    // 2 local reconcile -- failure here is a partial success (207), never reverts Gigared.
    try {
      const { contractServiceId } = await reconcileTvContractService({
        gigared: this.gigared,
        csRepo: this.csRepo,
        catalogRepo: this.catalogRepo,
        customerId,
        contractId,
        internalId,
        // #131 PARTE B -- thread actor + tvEventRepo so reconcile can record reactivacion.
        actor: actorId !== undefined || actorName !== undefined
          ? { actorId: actorId ?? null, actorName: actorName ?? '' }
          : undefined,
        tvEventRepo: this.tvEventRepo,
      });
      const result: AddTvServiceResult = { gigared: 'ok', local: 'ok' };
      if (contractServiceId) result.contractServiceId = contractServiceId;
      return result;
    } catch (e) {
      return { gigared: 'ok', local: 'failed', localError: (e as Error).message };
    }
  }
}
