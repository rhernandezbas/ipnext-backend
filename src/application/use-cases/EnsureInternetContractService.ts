import { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';

export interface EnsureInternetOpts {
  reason?: string | null;
  actorId?: string | null;
  actorName?: string;
}

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
 * pppoe-baja-motivo: cuando hay eventRepo, registra un evento 'deactivated'/'activated'
 * en cada transición real (no en no-ops). El record() es best-effort (try/catch + warn).
 *
 * Espeja el patrón de `reconcileTvContractService` pero sin la complejidad de Gigared.
 */
export class EnsureInternetContractService {
  constructor(
    private readonly csRepo: ContractServiceRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    /** pppoe-baja-motivo: optional; keeps back-compat with callers that don't pass it. */
    private readonly eventRepo?: ContractServiceEventRepository,
  ) {}

  /**
   * Returns `true` if a transition occurred and an 'activated'/'deactivated' event was
   * recorded (or attempted). Returns `false` when the line was already in the desired
   * state (no-op).
   *
   * Callers that need to record an 'activated' event WITH actor even in the already-active
   * case (e.g. CreatePppoeService, AssociatePppoeToContract when fix-operador is needed)
   * can check the return value and record the event themselves.
   */
  async execute(contractId: string, active: boolean, opts?: EnsureInternetOpts): Promise<boolean> {
    const catalog = await this.catalogRepo.getByName('INTERNET');
    if (!catalog || !catalog.active) {
      console.warn(`[EnsureInternetContractService] catálogo INTERNET no disponible (contractId=${contractId})`);
      return false;
    }

    const existing = await this.csRepo.getByPair(contractId, catalog.id);

    if (active) {
      if (!existing) {
        await this.csRepo.add({ contractId, serviceCatalogId: catalog.id, notes: null });
        await this.recordEvent(contractId, catalog.id, 'activated', opts);
        return true;
      } else if (existing.status !== 'active') {
        await this.csRepo.update(existing.id, { status: 'active' });
        await this.recordEvent(contractId, catalog.id, 'activated', opts);
        return true;
      }
      // else: ya active → no-op, no evento
      return false;
    } else {
      if (existing && existing.status === 'active') {
        await this.csRepo.update(existing.id, { status: 'inactive' });
        await this.recordEvent(contractId, catalog.id, 'deactivated', opts);
        return true;
      }
      // else: no existe o ya inactive → no-op, no evento
      return false;
    }
  }

  /** Best-effort event recording — NEVER throws. */
  private async recordEvent(
    contractId: string,
    serviceCatalogId: string,
    eventType: 'activated' | 'deactivated',
    opts?: EnsureInternetOpts,
  ): Promise<void> {
    if (!this.eventRepo) return;
    try {
      await this.eventRepo.record({
        contractId,
        serviceCatalogId,
        eventType,
        actorId:   opts?.actorId ?? null,
        actorName: opts?.actorName ?? '',
        reason:    opts?.reason ?? null,
      });
    } catch (err) {
      console.warn('[EnsureInternetContractService] Failed to record event (best-effort):', err);
    }
  }
}
