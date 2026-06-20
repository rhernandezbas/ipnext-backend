import { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';

/**
 * EnsureInternetContractService — helper de reconcile de la línea INTERNET (#1).
 *
 * Best-effort: todos los errores se tragan silenciosamente (warn). Este helper NUNCA
 * debe romper la operación PPPoE que lo llama. La invariante crítica es el PPPoE;
 * la línea INTERNET es reflejo.
 *
 * Lógica:
 *   - resuelve el catálogo 'INTERNET' (getByName). Si no existe o está inactive → warn + return.
 *   - active=true:  si no hay línea → crea (status 'active'); si hay inactive → reactiva; si ya active → no-op.
 *   - active=false: si hay línea active → inactiva; si no hay o ya inactive → no-op.
 *
 * Espeja el patrón de `reconcileTvContractService` pero sin la complejidad de Gigared.
 */
export class EnsureInternetContractService {
  constructor(
    private readonly csRepo: ContractServiceRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
  ) {}

  async execute(contractId: string, active: boolean): Promise<void> {
    const catalog = await this.catalogRepo.getByName('INTERNET');
    if (!catalog || !catalog.active) {
      console.warn(`[EnsureInternetContractService] catálogo INTERNET no disponible (contractId=${contractId})`);
      return;
    }

    const existing = await this.csRepo.getByPair(contractId, catalog.id);

    if (active) {
      if (!existing) {
        await this.csRepo.add({ contractId, serviceCatalogId: catalog.id, notes: null });
      } else if (existing.status !== 'active') {
        await this.csRepo.update(existing.id, { status: 'active' });
      }
      // else: ya active → no-op
    } else {
      if (existing && existing.status === 'active') {
        await this.csRepo.update(existing.id, { status: 'inactive' });
      }
      // else: no existe o ya inactive → no-op
    }
  }
}
