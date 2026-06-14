import { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';
import { ContractServiceView } from '@domain/entities/contract-service';
import { ContractServiceNotFoundError } from '@domain/errors/contractServices';

export interface ActorInput {
  actorId:   string | null;
  actorName: string;
}

export class UpdateContractService {
  constructor(
    private readonly csRepo: ContractServiceRepository,
    /** #110 — optional: when present, registers status-change events (best-effort). */
    private readonly eventRepo?: ContractServiceEventRepository,
  ) {}

  async execute(
    id: string,
    data: { status?: string; notes?: string | null },
    actor?: ActorInput,
  ): Promise<ContractServiceView> {
    // #110 — read previous status BEFORE update to detect transitions
    let prevStatus: string | undefined;
    if (this.eventRepo && data.status !== undefined) {
      const prev = await this.csRepo.getById(id);
      if (!prev) throw new ContractServiceNotFoundError(id);
      prevStatus = prev.status;
    }

    const updated = await this.csRepo.update(id, data);
    if (!updated) throw new ContractServiceNotFoundError(id);

    // #110 — best-effort event registration on status transition
    if (this.eventRepo && data.status !== undefined && prevStatus !== undefined) {
      const isTransition = data.status !== prevStatus;
      if (isTransition) {
        let eventType: 'deactivated' | 'reactivated';
        if (data.status === 'inactive') {
          eventType = 'deactivated';
        } else {
          eventType = 'reactivated';
        }
        try {
          await this.eventRepo.record({
            contractId:       updated.contractId,
            serviceCatalogId: updated.serviceCatalogId,
            eventType,
            actorId:          actor?.actorId ?? null,
            actorName:        actor?.actorName ?? '',
          });
        } catch (err) {
          console.warn('[UpdateContractService] Failed to record status-change event (best-effort):', err);
        }
      }
    }

    return updated;
  }
}
