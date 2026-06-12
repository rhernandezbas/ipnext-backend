import type { GigaredPort } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { CancelTvResult } from '@application/dto/gigared.dto';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { GigaredNotFoundError, TvNotLinkedError } from '@domain/errors/gigared';
import type { CustomerLookup, ContractLookup } from './lookups';
import { reconcileTvContractService } from './reconcileTvContractService';

/**
 * CancelTv (#47k) — dar de baja TV por completo para un cliente.
 *
 * Guard order (pinned): customer 404 → contract 404 (ANTES de tocar Gigared) →
 *   cuenta del cliente por use_internal_id; un 404 upstream (no vinculada) se mapea a
 *   TvNotLinkedError (router → 404 TV_NOT_LINKED).
 *
 * Luego, por cada servicio de la cuenta: DELETE en Gigared (incluido el base — libera
 * cupo). Cada DELETE es independiente: si uno falla, se registra en `failed` y se sigue
 * con el resto (nunca aborta el lote). Después, OTT disable (idempotente: el adapter ya
 * tolera "ya deshabilitada" como éxito). Por último, reconcile del ContractService TV:
 * relee la cuenta y, si quedó vacía, INACTIVA el ítem local (helper existente, H1).
 *
 * Idempotente por diseño (retry = re-POST): los packs ya quitados no están en la cuenta
 * en la re-corrida → no se reintentan; el "ya deshabilitada" del OTT es éxito.
 *
 * Shape: { removed, failed, ottDisabled, local }. El router responde 200 si
 * failed.length === 0 && local === 'synced', si no 207.
 */
export class CancelTv {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly csRepo: ContractServiceRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly contractLookup: ContractLookup,
    private readonly customerLookup: CustomerLookup,
  ) {}

  async execute(customerId: string, { contractId }: { contractId: string }): Promise<CancelTvResult> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    // #47k HIGH: el contrato debe PERTENECER al customer. Un contractId de otro cliente
    // se trata como inexistente (404) para no filtrar la existencia del contrato ajeno ni
    // permitir un write cross-customer en una acción destructiva.
    const contract = await this.contractLookup.findById(contractId);
    if (!contract || contract.clientId !== customerId) throw new ContractNotFoundError(contractId);

    // Cuenta del cliente — un 404 upstream significa "no vinculada".
    let account;
    try {
      account = await this.gigared.getAccountByInternalId(customerId);
    } catch (e) {
      if (e instanceof GigaredNotFoundError) throw new TvNotLinkedError(customerId);
      throw e;
    }

    // DELETE por servicio (base incluido — libera cupo). Cada uno es independiente.
    const removed: string[] = [];
    const failed: { id: string; detail: string }[] = [];
    for (const service of account.services) {
      try {
        await this.gigared.removeService(customerId, service.id);
        removed.push(service.id);
      } catch (e) {
        failed.push({ id: service.id, detail: (e as Error).message });
      }
    }

    // OTT disable — idempotente (el adapter tolera "ya deshabilitada"). Se intenta SIEMPRE,
    // aun con fallos parciales en los DELETE. Un fallo acá no rompe la baja: ottDisabled=false.
    let ottDisabled = false;
    try {
      await this.gigared.setOtt(customerId, false);
      ottDisabled = true;
    } catch {
      ottDisabled = false;
    }

    // Reconcile local: relee la cuenta; si quedó vacía, inactiva el ítem TV (H1, nunca borra).
    let local: 'synced' | 'failed' = 'synced';
    try {
      await reconcileTvContractService({
        gigared: this.gigared,
        csRepo: this.csRepo,
        catalogRepo: this.catalogRepo,
        customerId,
        contractId,
      });
    } catch {
      local = 'failed';
    }

    return { removed, failed, ottDisabled, local };
  }
}
