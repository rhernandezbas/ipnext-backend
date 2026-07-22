import { ContractServiceRepository } from "@domain/ports/ContractServiceRepository";
import { ContractServiceEventRepository } from "@domain/ports/ContractServiceEventRepository";
import { TvActivationEventRepository } from "@domain/ports/TvActivationEventRepository";
import {
  ContractServiceHistoryItemDto,
  ServiceEventDto,
  toContractServiceHistoryItemDto,
  tvEventToServiceEvent,
} from "@application/dto/contract-services.dto";

/**
 * #73 / #110 -- Returns the FULL service history (active + inactive ContractService rows)
 * for a given contract, each item enriched with its chronological event sequence.
 *
 * Cross-source strategy:
 *   - Non-TV service  -> events from ContractServiceEventRepository by (contractId, serviceCatalogId)
 *   - TV service      -> events MERGED from BOTH:
 *       a) TvActivationEventRepository by contractId  (alta/baja/reactivacion)
 *       b) ContractServiceEventRepository by (contractId, serviceCatalogId) (e.g. baja via RemoveContractService)
 *     Combined list sorted ASC. synthesizeLegacyEvents only when BOTH sources are empty. (#131)
 *
 * Legacy degradation: if a service has no events (pre-migration row), synthesize a minimal
 * sequence from createdAt / deactivatedAt.
 *
 * tvPassword is NEVER present in the returned DTOs -- the mapper strips it at the boundary.
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
          notes:      ev.notes ?? null,
          // service-transfer fix wave MEDIUM-5 (aditivo) — la ficha etiqueta transferencias
          // por changeKind y muestra la dirección con oldValue/newValue.
          changeKind: ev.changeKind ?? null,
          oldValue:   ev.oldValue ?? null,
          newValue:   ev.newValue ?? null,
        });
      }
    }

    // Pre-fetch TV events for the contract (only if at least one TV service).
    // ASSUMPTION: a contract has at most 1 TV service (Gigared TV is 1 per contract/client, #81).
    // tv_activation_events has no serviceCatalogId column, so we filter only by contractId and
    // assign the same event list to every row where isTvRow. If a contract ever had >1
    // TV service, both rows would show the same events -- accepted per #81 constraint; do NOT
    // change the schema to add serviceCatalogId without revisiting this cross-source strategy.
    let tvEvents: ServiceEventDto[] = [];
    const hasTV = views.some(isTvRow);
    if (hasTV && this.tvEventRepo) {
      const raw = await this.tvEventRepo.listByContract(contractId);
      // gigared-tv-identity-hardening (F4) — FILTRAR 'transferencia' de la ficha POR-CONTRATO: la
      // transferencia ya se muestra acá vía el par CSE transfer-out/transfer-in (changeKind, arriba),
      // así que incluir además el tv_activation_event 'transferencia' la duplicaría como un "Alta"
      // fantasma y rompería el invariante de disyunción (L88-91). El evento GLOBAL
      // (ListTvActivationHistory) NO se toca: 'transferencia' se filtra sólo en ESTA vista.
      tvEvents = raw
        .filter(e => e.eventType !== 'transferencia')
        .map(tvEventToServiceEvent);
    }

    return views.map(view => {
      let events: ServiceEventDto[];

      if (isTvRow(view)) {
        // TV service (#131): merge events from BOTH sources:
        //   a) tv_activation_events (pre-fetched above as tvEvents)
        //   b) contract_service_events by (contractId, serviceCatalogId) -- e.g. baja via RemoveContractService
        // This fixes BUG A (operador vacio) and BUG B (fecha vieja) when the baja event landed
        // in contract_service_events instead of tv_activation_events.
        const cseEvents = cseByService.get(view.serviceCatalogId) ?? [];
        // INVARIANT: tv_activation_events and contract_service_events are disjoint for any
        // given TV row -- the two tables record different operations and never produce the same
        // event for the same row at the same moment. No deduplication is needed; if that
        // assumption ever changes, add dedup here keyed on (eventType, occurredAt).
        const merged = [...tvEvents, ...cseEvents];
        if (merged.length > 0) {
          events = [...merged].sort(byOccurredAtAsc);
        } else {
          // Both sources empty: fall back to legacy synthesis from createdAt / deactivatedAt.
          // Spec R1.3: the modal ALWAYS shows at least the alta.
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

/**
 * #135 rev -- Detects whether a ContractService row belongs to a TV service.
 * Uses structural signals only: tvLogin (set while active) or catalog name === 'TV'.
 * After CancelTv, tvLogin is cleared to null, but name='TV' is the stable catalog identity
 * and covers inactive TV rows without relying on free-text notes.
 *
 * Supersedes the notes.startsWith('CIC ') approach which caused false positives when
 * non-TV rows (e.g. name='Internet') had notes starting with 'CIC '.
 */
function isTvRow(view: { tvLogin: string | null; name: string }): boolean {
  return view.tvLogin !== null || view.name === 'TV';
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
      notes:      null,
      changeKind: null,
      oldValue:   null,
      newValue:   null,
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
      notes:      null,
      changeKind: null,
      oldValue:   null,
      newValue:   null,
    });
  }
  return events;
}
