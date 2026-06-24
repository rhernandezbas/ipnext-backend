import type { PppoeServiceRepository, PppoeServiceWithClient } from '@domain/ports/PppoeServiceRepository';
import type { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { pppoeDisplayStatus, type PppoeDisplayStatus } from '@domain/entities/pppoeService';
import type { PppoeServiceListItemDto, PppoeServiceListPageDto } from '@application/dto/pppoe.dto';

export interface ListAllPppoeServicesFilter {
  search?: string;
  status?: string;
  nasId?: string;
  page?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * ListAllPppoeServices (internet-history) — GLOBAL paginated list of ALL PppoeService rows,
 * the Internet services page (mirror of the TV list). Each item is enriched with its
 * contract→client (clientId, customerName, resolved by the repo) and with `createdBy`: the
 * actorName of the contract's INTERNET 'activated' event, when available.
 *
 * createdBy resolution is done HERE (not in the repo) to keep the client-cross in the repo
 * and the actor-cross in the use case, which already owns the catalog + event repos. We fetch
 * only the internet events whose contractId is IN the current page's contracts (push-down via
 * the `contractIds` filter), so the enrichment is bounded by the page size — NOT by the full
 * historical event count.
 *
 * The DTO is curated and NEVER exposes the PPPoE password.
 */
export class ListAllPppoeServices {
  constructor(
    private readonly pppoeRepo: PppoeServiceRepository,
    private readonly eventRepo: ContractServiceEventRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
  ) {}

  async execute(filters: ListAllPppoeServicesFilter): Promise<PppoeServiceListPageDto> {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, filters.limit ?? DEFAULT_LIMIT));

    // The `status` filter arrives in BUSINESS vocabulary; ignore unknown values (fail-open: no filter).
    const displayStatus = isDisplayStatus(filters.status) ? filters.status : undefined;

    const { data, total } = await this.pppoeRepo.listAllPaginated({
      page,
      pageSize: limit,
      ...(filters.search ? { search: filters.search } : {}),
      ...(displayStatus ? { displayStatus } : {}),
      ...(filters.nasId ? { nasId: filters.nasId } : {}),
    });

    const createdByByContract = await this.resolveCreatedBy(data);

    return {
      data: data.map(s => toDto(s, s.contractId ? createdByByContract.get(s.contractId) ?? null : null)),
      total,
      page,
      limit,
    };
  }

  /**
   * Map contractId → actorName of its INTERNET 'activated' event (the service creator).
   * Returns an empty map if there's no INTERNET catalog entry or no contracts in the page.
   */
  private async resolveCreatedBy(rows: PppoeServiceWithClient[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const contractIds = new Set(rows.map(r => r.contractId).filter((c): c is string => c !== null));
    if (contractIds.size === 0) return result;

    const internet = await this.catalogRepo.getByName('INTERNET');
    if (!internet) return result;

    // Push-down: scope the query to the page's contracts (SQL `contractId IN (...)`), so this is
    // bounded by the page size — NOT by the full historical INTERNET event count. Then pick the
    // earliest 'activated' per contract.
    const events = await this.eventRepo.list({
      serviceCatalogId: internet.id,
      contractIds: [...contractIds],
    });
    // events are newest-first; iterate oldest-first so the earliest 'activated' wins per contract.
    for (const ev of [...events].reverse()) {
      if (ev.eventType !== 'activated') continue;
      if (!contractIds.has(ev.contractId)) continue;
      if (!result.has(ev.contractId) && ev.actorName) {
        result.set(ev.contractId, ev.actorName);
      }
    }
    return result;
  }
}

const DISPLAY_STATUSES: readonly PppoeDisplayStatus[] = ['active', 'reduced', 'blocked', 'baja', 'inactive'];

function isDisplayStatus(v: string | undefined): v is PppoeDisplayStatus {
  return v !== undefined && (DISPLAY_STATUSES as readonly string[]).includes(v);
}

function toDto(s: PppoeServiceWithClient, createdBy: string | null): PppoeServiceListItemDto {
  return {
    id:            s.id,
    username:      s.username,
    profile:       s.profile,
    // BUSINESS status (active|reduced|blocked|baja|inactive), NOT the raw RADIUS status.
    status:        pppoeDisplayStatus(s.status, s.enforcedState),
    enforcedState: s.enforcedState,
    nasId:         s.nasId,
    contractId:    s.contractId,
    clientId:      s.clientId,
    customerName:  s.customerName,
    createdBy,
    createdAt:     s.createdAt,
  };
}
