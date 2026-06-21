import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';
import { EnforcementAction } from '@domain/entities/pppoeService';

const ACTION_EVENT = {
  reduce:  'reduced',
  block:   'blocked',
  restore: 'restored',
} as const;

export interface RecordPppoeEnforceEventOpts {
  reason?:    string | null;
  actorId?:   string | null;
  actorName?: string;
}

/**
 * RecordPppoeEnforceEvent — helper de registro de eventos de enforcement PPPoE (pppoe-corte-individual).
 *
 * Best-effort: todos los errores se tragan silenciosamente (warn). Este helper NUNCA
 * debe romper la operación PPPoE que lo llama. La invariante crítica es el corte;
 * el evento es reflejo auditable.
 *
 * Lógica:
 *   - resuelve el catálogo 'INTERNET' (getByName). Si no existe → warn + return.
 *   - registra un evento con eventType = ACTION_EVENT[action] (reduced/blocked/restored).
 *
 * Espeja el patrón best-effort de `EnsureInternetContractService.recordEvent`.
 */
export class RecordPppoeEnforceEvent {
  constructor(
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly eventRepo: ContractServiceEventRepository,
  ) {}

  async execute(
    contractId: string,
    action: EnforcementAction,
    opts: RecordPppoeEnforceEventOpts,
  ): Promise<void> {
    try {
      const catalog = await this.catalogRepo.getByName('INTERNET');
      if (!catalog) {
        console.warn(`[RecordPppoeEnforceEvent] catálogo INTERNET no disponible (contractId=${contractId})`);
        return;
      }
      await this.eventRepo.record({
        contractId,
        serviceCatalogId: catalog.id,
        eventType:  ACTION_EVENT[action],
        reason:     opts.reason ?? null,
        actorId:    opts.actorId ?? null,
        actorName:  opts.actorName ?? '',
      });
    } catch (err) {
      console.warn('[RecordPppoeEnforceEvent] Failed to record event (best-effort):', err);
    }
  }
}
