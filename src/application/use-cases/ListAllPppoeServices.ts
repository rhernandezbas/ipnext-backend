import type { PppoeServiceRepository, PppoeServiceWithClient } from '@domain/ports/PppoeServiceRepository';
import type { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { NasRepository } from '@domain/ports/NasRepository';
import { pppoeDisplayStatus, type PppoeDisplayStatus } from '@domain/entities/pppoeService';
import type { PppoeServiceListItemDto, PppoeServiceListPageDto } from '@application/dto/pppoe.dto';

export interface ListAllPppoeServicesFilter {
  search?: string;
  status?: string;
  nasId?: string;
  page?: number;
  limit?: number;
  /** pppoe-full-management: cuando true, incluye PPPoE sin contrato (huérfanos). Default false. */
  includeUnassigned?: boolean;
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
    /** pppoe-full-management: opcional — si se inyecta, enriquece con nasName/nasType. */
    private readonly nasRepo?: NasRepository,
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
      ...(filters.includeUnassigned ? { includeUnassigned: true } : {}),
    });

    const createdByByContract = await this.resolveCreatedBy(data);

    // pppoe-full-management: batch NAS enrichment (nasName/nasType) cuando nasRepo está disponible.
    const nasById = await this.resolveNasInfo(data);

    return {
      data: data.map(s => toDto(
        s,
        s.contractId ? createdByByContract.get(s.contractId) ?? null : null,
        nasById.get(s.nasId) ?? null,
      )),
      total,
      page,
      limit,
    };
  }

  /** Batch NAS enrichment: nasId → { name, type }. Empty map if nasRepo not injected. */
  private async resolveNasInfo(rows: PppoeServiceWithClient[]): Promise<Map<string, { name: string; type: string }>> {
    const result = new Map<string, { name: string; type: string }>();
    if (!this.nasRepo) return result;

    const uniqueNasIds = new Set(rows.map(r => r.nasId));
    if (uniqueNasIds.size === 0) return result;

    // Batch fetch all NAS servers and index by id (no N+1).
    const allNas = await this.nasRepo.findAllNasServers();
    for (const nas of allNas) {
      if (uniqueNasIds.has(nas.id)) {
        result.set(nas.id, { name: nas.name, type: nas.type });
      }
    }
    return result;
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

function toDto(
  s: PppoeServiceWithClient,
  createdBy: string | null,
  nasInfo: { name: string; type: string } | null,
): PppoeServiceListItemDto {
  return {
    id:            s.id,
    username:      s.username,
    profile:       s.profile,
    // BUSINESS status (active|reduced|blocked|baja|inactive), NOT the raw RADIUS status.
    status:        pppoeDisplayStatus(s.status, s.enforcedState),
    enforcedState: s.enforcedState,
    remoteAddress: s.remoteAddress,
    ipMode:        s.ipMode ?? 'fixed',
    nasId:         s.nasId,
    nasName:       nasInfo?.name ?? null,
    nasType:       nasInfo?.type ?? null,
    contractId:    s.contractId,
    clientId:      s.clientId,
    customerName:  s.customerName,
    createdBy,
    // pppoe-search-bulk-plan: MAC del CPE. El repo ya lo selecciona; aquí lo exponemos en el DTO.
    callerId:      s.callerId ?? null,
    createdAt:     s.createdAt,
  };
}
