import { RecaptureRepository, ListRecaptureLeadsQuery } from '@domain/ports/RecaptureRepository';
import { ContractRepository } from '@domain/ports/ContractRepository';
import { CustomerRepository, ActiveClientContact } from '@domain/ports/CustomerRepository';
import { PaginatedResult } from '@application/dto/pagination';
import { RecaptureLeadListItemDto, toRecaptureLeadDto } from '@application/dto/recapture/recapture.dto';
import { deriveTechnology } from '@application/use-cases/deriveTechnology';
import { matchActiveClient } from '@application/use-cases/recapture/matchActiveClient';

export class ListRecaptureLeads {
  constructor(
    private readonly repo: RecaptureRepository,
    private readonly contractRepo: ContractRepository,
    private readonly customerRepo: CustomerRepository,
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
    // recapture-active-client-match (design.md Decisión 6) — piggybacks the SAME
    // batch: no extra query. Gathers every non-null `Contract.motivoBaja` per
    // clientId so the churn_reason signal can fire from either source.
    const motivoBajaByClient = new Map<string, Set<string>>();
    if (clientIds.length > 0) {
      const rows = await this.contractRepo.findContractTechnologiesByClientIds(clientIds);
      for (const row of rows) {
        // DERIVE the effective technology (manual value wins; else classify by plan
        // speed). Identical rule to ListContracts → ZERO drift. trim() keeps the
        // dedup Set clean and drops whitespace-only manual values.
        const tech = deriveTechnology(row.technology, row.plan)?.trim();
        if (tech) {
          const set = technologiesByClient.get(row.clientId) ?? new Set<string>();
          set.add(tech);
          technologiesByClient.set(row.clientId, set);
        }
        if (row.motivoBaja) {
          const mset = motivoBajaByClient.get(row.clientId) ?? new Set<string>();
          mset.add(row.motivoBaja);
          motivoBajaByClient.set(row.clientId, mset);
        }
      }
    }

    // ── 3. Enrich the page with "posible cliente activo" signals ───────────────
    // ONE batch call reused across the whole page (design.md Decisión 1 — no
    // N+1). NEVER runs when the page is empty (nothing to match against). The
    // call is fail-OPEN: a broken candidate-set read must never break the list
    // itself, which is the primary function of this endpoint (design.md Decisión 3).
    let activeContacts: ActiveClientContact[] = [];
    if (result.data.length > 0) {
      try {
        activeContacts = await this.customerRepo.listActiveContacts();
      } catch {
        activeContacts = [];
      }
    }

    return {
      ...result,
      data: result.data.map((lead) => {
        // SOURCE-AGNOSTIC churn text seam (design.md Decisión 6): merges BOTH
        // sources — `lead.churnReason` (CSV import / IngestChurnedClients) AND
        // every persisted `Contract.motivoBaja` of the lead's own client (read from
        // the SAME batch above, zero extra query). Nulls filtered.
        const motivoTexts = lead.clientId ? [...(motivoBajaByClient.get(lead.clientId) ?? [])] : [];
        const churnReasonTexts = [lead.churnReason, ...motivoTexts].filter(
          (t): t is string => !!t,
        );
        const { signals } = matchActiveClient(
          { clientId: lead.clientId, phone: lead.phone, email: lead.email },
          activeContacts,
          churnReasonTexts,
        );

        return {
          ...toRecaptureLeadDto(lead),
          technologies: lead.clientId
            ? [...(technologiesByClient.get(lead.clientId) ?? [])]
            : [],
          possibleActiveMatchSignals: signals,
        };
      }),
    };
  }
}
