import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { PppoeServiceNotFoundError, PppoeAlreadyAssociatedError, PppoeContractAlreadyHasServiceError } from '@domain/errors/pppoe';
import { EnsureInternetContractService } from './EnsureInternetContractService';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';

/**
 * AssociatePppoeToContract — asocia un PPPoE huérfano (adoptado del inventario) a un contrato.
 *
 * Orden de guardas (pinned por el design):
 *   1. findById → 404 si no existe.
 *   2. Si pppoe.contractId === contractId → idempotente, return (re-asociar el mismo no es error).
 *   3. Si pppoe.contractId !== null (otro contrato) → PppoeAlreadyAssociatedError (→ 409).
 *   4. findByContract(contractId) → si hay uno con status='enabled' → PppoeContractAlreadyHasServiceError (→ 409).
 *   5. setContractId + ensureInternet(true) best-effort.
 */
export class AssociatePppoeToContract {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly ensureInternet: EnsureInternetContractService,
    /** fix-operador-alta: optional repos for recording 'activated' event even when line is already active. */
    private readonly catalogRepo?: ServiceCatalogRepository,
    private readonly eventRepo?: ContractServiceEventRepository,
  ) {}

  async execute(
    pppoeId: string,
    contractId: string,
    actor?: { actorId?: string | null; actorName?: string },
  ): Promise<PppoeService> {
    const pppoe = await this.repo.findById(pppoeId);
    if (!pppoe) throw new PppoeServiceNotFoundError(pppoeId);

    if (pppoe.contractId !== null) {
      if (pppoe.contractId === contractId) return pppoe; // idempotente: mismo contrato
      throw new PppoeAlreadyAssociatedError(pppoeId, pppoe.contractId);
    }

    // Guard #4: ¿el contrato ya tiene un PPPoE activo?
    const existing = await this.repo.findByContract(contractId);
    const activeExisting = existing.find(p => p.status === 'enabled');
    if (activeExisting) {
      throw new PppoeContractAlreadyHasServiceError(contractId, activeExisting.id);
    }

    const updated = await this.repo.setContractId(pppoeId, contractId);
    // setContractId solo devuelve null si la fila desapareció entre el findById y el update (carrera).
    if (!updated) throw new PppoeServiceNotFoundError(pppoeId);

    // Best-effort: la línea INTERNET del contrato queda active.
    // fix-operador-alta: if ensureInternet no-ops (line already active), record 'activated'
    // event explicitly with actor so the operador is not empty.
    try {
      const opts = actor ? { actorId: actor.actorId ?? null, actorName: actor.actorName } : undefined;
      const recorded = await this.ensureInternet.execute(contractId, true, opts);
      if (!recorded && actor && this.catalogRepo && this.eventRepo) {
        // Line was already active (no-op): still record the 'activated' event with actor.
        try {
          const catalog = await this.catalogRepo.getByName('INTERNET');
          if (catalog) {
            await this.eventRepo.record({
              contractId,
              serviceCatalogId: catalog.id,
              eventType: 'activated',
              actorId: actor.actorId ?? null,
              actorName: actor.actorName ?? '',
              reason: null,
            });
          }
        } catch (innerErr) {
          console.warn('[AssociatePppoeToContract] fallback activated event failed (best-effort):', innerErr);
        }
      }
    } catch (err) {
      console.warn('[AssociatePppoeToContract] ensureInternet(true) falló (best-effort):', err);
    }

    return updated;
  }
}
