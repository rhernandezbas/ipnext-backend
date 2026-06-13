import type { TvActivationEventRepository } from '@domain/ports/TvActivationEventRepository';
import type { TvActivationEventDto } from '@application/dto/gigared.dto';

export interface ListTvActivationHistoryFilter {
  actorId?: string;
  /** customerId maps to clientId in the domain. */
  customerId?: string;
  from?: Date;
  to?: Date;
}

/**
 * ListTvActivationHistory (#5 BE) — query use case for the TV activation/baja log.
 *
 * Two entry points:
 *   - `execute(filters)` — global list with optional filters (actorId, customerId, from, to)
 *   - `executeByClient(clientId)` — per-client shortcut (no additional filters)
 *
 * Results are always newest-first; mapping to DTO is done here (no raw domain objects leak out).
 */
export class ListTvActivationHistory {
  constructor(private readonly repo: TvActivationEventRepository) {}

  async execute(filters: ListTvActivationHistoryFilter): Promise<TvActivationEventDto[]> {
    const events = await this.repo.list({
      actorId:  filters.actorId,
      clientId: filters.customerId,
      from:     filters.from,
      to:       filters.to,
    });
    return events.map(toDto);
  }

  async executeByClient(clientId: string): Promise<TvActivationEventDto[]> {
    const events = await this.repo.listByClient(clientId);
    return events.map(toDto);
  }
}

function toDto(e: {
  id: string;
  clientId: string;
  actorId: string | null;
  actorName: string;
  eventType: 'alta' | 'baja' | 'reactivacion';
  cic: string | null;
  internalId: string | null;
  seq: number | null;
  contractId: string | null;
  createdAt: string;
}): TvActivationEventDto {
  return {
    id:          e.id,
    clientId:    e.clientId,
    actorId:     e.actorId,
    actorName:   e.actorName,
    eventType:   e.eventType,
    cic:         e.cic,
    internalId:  e.internalId,
    seq:         e.seq,
    contractId:  e.contractId,
    createdAt:   e.createdAt,
  };
}
