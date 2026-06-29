import { RecaptureRepository, ListRecaptureLeadsQuery } from '@domain/ports/RecaptureRepository';
import { ContractRepository } from '@domain/ports/ContractRepository';
import { PaginatedResult } from '@application/dto/pagination';
import { RecaptureLeadListItemDto, toRecaptureLeadDto } from '@application/dto/recapture/recapture.dto';

export class ListRecaptureLeads {
  constructor(
    private readonly repo: RecaptureRepository,
    private readonly contractRepo: ContractRepository,
  ) {}

  async execute(query: ListRecaptureLeadsQuery): Promise<PaginatedResult<RecaptureLeadListItemDto>> {
    // ── 1. Resolve the `technology` filter to clientIds, SERVER-SIDE ────────────
    // Done BEFORE listing so pagination runs over the filtered set, not after it.
    let listQuery = query;
    if (query.technology) {
      const clientIds = await this.contractRepo.findClientIdsByTechnology(query.technology);
      if (clientIds.length === 0) {
        // No client owns a contract of this technology → empty page (correct totals).
        return { data: [], total: 0, page: query.page ?? 1, limit: query.limit ?? 25 };
      }
      listQuery = { ...query, clientIds };
    }

    const result = await this.repo.list(listQuery);

    // ── 2. Enrich the page with technologies via a SINGLE batch query ───────────
    const clientIds = [
      ...new Set(
        result.data
          .map((lead) => lead.clientId)
          .filter((id): id is string => id !== null),
      ),
    ];

    const technologiesByClient = new Map<string, Set<string>>();
    if (clientIds.length > 0) {
      const rows = await this.contractRepo.findContractTechnologiesByClientIds(clientIds);
      for (const row of rows) {
        const tech = row.technology?.trim();
        if (!tech) continue; // drop null / empty / whitespace-only
        const set = technologiesByClient.get(row.clientId) ?? new Set<string>();
        set.add(tech);
        technologiesByClient.set(row.clientId, set);
      }
    }

    return {
      ...result,
      data: result.data.map((lead) => ({
        ...toRecaptureLeadDto(lead),
        technologies: lead.clientId
          ? [...(technologiesByClient.get(lead.clientId) ?? [])]
          : [],
      })),
    };
  }
}
