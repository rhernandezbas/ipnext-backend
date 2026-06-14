import { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';

export interface ActorInput {
  actorId:   string | null;
  actorName: string;
}

export class RemoveContractService {
  constructor(
    private readonly csRepo: ContractServiceRepository,
    /** #110 — optional: when present, registers a 'deactivated' event on active-service removal. */
    private readonly eventRepo?: ContractServiceEventRepository,
  ) {}

  /** Idempotent: a missing id is a no-op (route returns 204 either way, spec CSV-3.2). */
  async execute(id: string, actor?: ActorInput): Promise<void> {
    // #110 — read the row before deletion to capture contractId, serviceCatalogId, and status
    let snapshotForEvent: { contractId: string; serviceCatalogId: string } | undefined;
    if (this.eventRepo) {
      const existing = await this.csRepo.getById(id);
      // Only register event if row exists AND was active (per design: "si existía y estaba active")
      if (existing && existing.status === 'active') {
        snapshotForEvent = {
          contractId:       existing.contractId,
          serviceCatalogId: existing.serviceCatalogId,
        };
      }
    }

    await this.csRepo.delete(id);

    // #110 — best-effort event registration (after successful delete)
    if (this.eventRepo && snapshotForEvent) {
      try {
        await this.eventRepo.record({
          contractId:       snapshotForEvent.contractId,
          serviceCatalogId: snapshotForEvent.serviceCatalogId,
          eventType:        'deactivated',
          actorId:          actor?.actorId ?? null,
          actorName:        actor?.actorName ?? '',
        });
      } catch (err) {
        console.warn('[RemoveContractService] Failed to record deactivated event (best-effort):', err);
      }
    }
  }
}
