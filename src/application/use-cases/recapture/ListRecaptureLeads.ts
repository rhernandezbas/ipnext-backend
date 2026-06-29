import { RecaptureRepository, ListRecaptureLeadsQuery } from '@domain/ports/RecaptureRepository';
import { ContractRepository } from '@domain/ports/ContractRepository';
import { PaginatedResult } from '@application/dto/pagination';
import { RecaptureLeadListItemDto, toRecaptureLeadDto } from '@application/dto/recapture/recapture.dto';
import { deriveTechnology } from '@application/use-cases/deriveTechnology';

export class ListRecaptureLeads {
  constructor(
    private readonly repo: RecaptureRepository,
    private readonly contractRepo: ContractRepository,
  ) {}

  async execute(query: ListRecaptureLeadsQuery): Promise<PaginatedResult<RecaptureLeadListItemDto>> {
    // ── 1. Resolve the `technology` filter to clientIds, SERVER-SIDE ────────────
    // Done BEFORE listing so pagination runs over the filtered set, not after it.
    // We match the DERIVED technology (deriveTechnology), NOT the raw Contract.technology
    // column — that column is NULL for every GR contract. Same source of truth as
    // ListContracts → ZERO drift. See findAllContractTechnologies for the read tradeoff.
    let listQuery = query;
    if (query.technology) {
      const rows = await this.contractRepo.findAllContractTechnologies();
      const clientIds = [
        ...new Set(
          rows
            .filter((r) => deriveTechnology(r.technology, r.plan) === query.technology)
            .map((r) => r.clientId),
        ),
      ];
      if (clientIds.length === 0) {
        // No client owns a contract that derives to this technology → empty page (correct totals).
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
        // DERIVE the effective technology (manual value wins; else classify by plan
        // speed). Identical rule to ListContracts → ZERO drift. trim() keeps the
        // dedup Set clean and drops whitespace-only manual values.
        const tech = deriveTechnology(row.technology, row.plan)?.trim();
        if (!tech) continue; // drop unclassified (null) / empty / whitespace-only
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
