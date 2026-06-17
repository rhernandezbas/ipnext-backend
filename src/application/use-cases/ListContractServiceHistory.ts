import { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';
import { TvActivationEventRepository } from '@domain/ports/TvActivationEventRepository';
import {
  ContractServiceHistoryItemDto,
  ServiceEventDto,
  toContractServiceHistoryItemDto,
  tvEventToServiceEvent,
} from '@application/dto/contract-services.dto';

/**
 * #73 / #110 — Returns the FULL service history (active + inactive ContractService rows)
 * for a given contract, each item enriched with its chronological event sequence.
 *
 * Cross-source strategy (Decisión 2):
 *   - TV service (tvLogin !== null) → events from TvActivationEventRepository by contractId
 *   - Non-TV service                → events from ContractServiceEventRepository by (contractId, serviceCatalogId)
 *
 * Legacy degradation (Decisión 3): if a non-TV service has no events (pre-migration row),
 * synthesize a minimal sequence from createdAt / deactivatedAt.
 *
 * tvPassword is NEVER present in the returned DTOs — the mapper strips it at the boundary.
 *
 * The cseRepo and tvEventRepo are OPTIONAL for backward-compat with existing tests that
 * were written before #110. When absent, legacy synthesis is used for all services.
 */
export class ListContractServiceHistory {
  constructor(
    private readonly csRepo: ContractServiceRepository,
    private readonly cseRepo?: ContractServiceEventRepository,
    private readonly tvEventRepo?: TvActivationEventRepository,
  ) {}

  async execute(contractId: string): Promise<ContractServiceHistoryItemDto[]> {
    const views = await this.csRepo.listByContract(contractId);
    if (views.length === 0) return [];

    // Pre-fetch all CSE events for the contract (one query, group by serviceCatalogId client-side)
    const cseByService = new Map<string, ServiceEventDto[]>();
    if (this.cseRepo) {
      const allCse = await this.cseRepo.listByContract(contractId);
      for (const ev of allCse) {
        const key = ev.serviceCatalogId;
        if (!cseByService.has(key)) cseByService.set(key, []);
        cseByService.get(key)!.push({
          id:         ev.id,
          eventType:  ev.eventType,
          occurredAt: ev.createdAt,
          actorName:  ev.actorName,
          cic:        null,
          reason:     ev.reason ?? null,
        });
      }
    }

    // Pre-fetch TV events for the contract (only if at least one TV service).
    // ASSUMPTION: a contract has at most 1 TV service (Gigared TV is 1 per contract/client, #81).
    // tv_activation_events has no serviceCatalogId column, so we filter only by contractId and
    // assign the same event list to every row where tvLogin !== null. If a contract ever had >1
    // TV service, both rows would show the same events — accepted per #81 constraint; do NOT
    // change the schema to add serviceCatalogId without revisiting this cross-source strategy.
    let tvEvents: ServiceEventDto[] = [];
    const hasTV = views.some(v => v.tvLogin !== null);
    if (hasTV && this.tvEventRepo) {
      const raw = await this.tvEventRepo.listByContract(contractId);
      tvEvents = raw.map(tvEventToServiceEvent);
    }

    return views.map(view => {
      let events: ServiceEventDto[];

      if (view.tvLogin !== null) {
        // TV service: use TV events ordered ASC.
        // If no tv_activation_events exist (legacy row created before the table was introduced —
        // migration 20260721000000), fall back to legacy synthesis from createdAt / deactivatedAt,
        // matching the non-TV branch. Spec R1.3: the modal ALWAYS shows at least the alta.
        if (tvEvents.length > 0) {
          events = [...tvEvents].sort(byOccurredAtAsc);
        } else {
          events = synthesizeLegacyEvents(view.createdAt, view.deactivatedAt);
        }
      } else {
        // Non-TV service: events from CSE repo for this serviceCatalogId
        const svcEvents = cseByService.get(view.serviceCatalogId) ?? [];
        if (svcEvents.length > 0) {
          events = [...svcEvents].sort(byOccurredAtAsc);
        } else {
          // Legacy synthesis: derive events from createdAt / deactivatedAt
          events = synthesizeLegacyEvents(view.createdAt, view.deactivatedAt);
        }
      }

      return toContractServiceHistoryItemDto(view, events);
    });
  }
}

/** Sort events chronologically ascending by occurredAt. */
function byOccurredAtAsc(a: ServiceEventDto, b: ServiceEventDto): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * For legacy rows with no recorded events: synthesize a minimal sequence.
 *   - Always produces an `activated` at createdAt.
 *   - If deactivatedAt is set, also produces a `deactivated`.
 */
function synthesizeLegacyEvents(createdAt: string, deactivatedAt: string | null): ServiceEventDto[] {
  const events: ServiceEventDto[] = [
    {
      id:         `synth-activated-${createdAt}`,
      eventType:  'activated',
      occurredAt: createdAt,
      actorName:  '',
      cic:        null,
      reason:     null,
    },
  ];
  if (deactivatedAt) {
    events.push({
      id:         `synth-deactivated-${deactivatedAt}`,
      eventType:  'deactivated',
      occurredAt: deactivatedAt,
      actorName:  '',
      cic:        null,
      reason:     null,
    });
  }
  return events;
}
