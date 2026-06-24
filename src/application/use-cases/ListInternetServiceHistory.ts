import type {
  ContractServiceEventRepository,
} from '@domain/ports/ContractServiceEventRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { InternetServiceEventDto } from '@application/dto/pppoe.dto';

export interface ListInternetServiceHistoryFilter {
  actorId?: string;
  /** customerId maps to clientId in the domain. */
  customerId?: string;
  clientId?: string;
  from?: Date;
  to?: Date;
}

/**
 * ListInternetServiceHistory (internet-history) — query use case for the GLOBAL internet
 * service activation/baja log. Mirror of ListTvActivationHistory for the Internet page.
 *
 * INTERNET is identified by ServiceCatalog.name === 'INTERNET'. The use case resolves the
 * catalog id once and passes it as the serviceCatalogId filter, so the result NEVER includes
 * TV nor any other service event. If the INTERNET catalog entry is missing, returns [] (no
 * events leak — failing closed is safer than returning the whole event log).
 *
 * Results are always newest-first; mapping to DTO happens here (no domain objects leak out).
 */
export class ListInternetServiceHistory {
  constructor(
    private readonly eventRepo: ContractServiceEventRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
  ) {}

  async execute(filters: ListInternetServiceHistoryFilter): Promise<InternetServiceEventDto[]> {
    const internet = await this.catalogRepo.getByName('INTERNET');
    if (!internet) return [];

    const events = await this.eventRepo.list({
      serviceCatalogId: internet.id,
      actorId:  filters.actorId,
      clientId: filters.clientId ?? filters.customerId,
      from:     filters.from,
      to:       filters.to,
    });
    return events.map(toDto);
  }
}

function toDto(e: {
  id: string;
  contractId: string;
  clientId: string | null;
  customerName: string | null;
  serviceCatalogId: string;
  eventType: string;
  actorId: string | null;
  actorName: string;
  reason: string | null;
  createdAt: string;
}): InternetServiceEventDto {
  return {
    id:               e.id,
    contractId:       e.contractId,
    clientId:         e.clientId,
    customerName:     e.customerName,
    serviceCatalogId: e.serviceCatalogId,
    eventType:        e.eventType,
    actorId:          e.actorId,
    actorName:        e.actorName,
    reason:           e.reason ?? null,
    createdAt:        e.createdAt,
  };
}
