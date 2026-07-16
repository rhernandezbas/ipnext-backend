import { ContractRepository, ListContractsQuery } from '@domain/ports/ContractRepository';
import { PaginatedContractsDto } from '../dto/contract.dto';
import { deriveTechnology } from './deriveTechnology';
import { mapContractStatus } from './mapContractStatus';

/**
 * Global paginated listing of contracts for the contracts page.
 * Depends on the ContractRepository port — never on Prisma.
 * Returns a DTO whose envelope matches the frontend PaginatedResponse exactly
 * ({ data, total, page, pageSize, totalPages }).
 */
export class ListContracts {
  constructor(private readonly repo: ContractRepository) {}

  async execute(query: ListContractsQuery): Promise<PaginatedContractsDto> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;

    const result = await this.repo.list({
      page,
      limit,
      search: query.search,
      status: query.status,
      technology: query.technology,
    });

    const totalPages = result.limit > 0 ? Math.max(1, Math.ceil(result.total / result.limit)) : 1;

    return {
      data: result.data.map((s) => ({
        id: s.id,
        code: s.code, // #55 — GR contract code
        clientId: s.clientId,
        clientName: s.clientName,
        plan: s.plan,
        // Map raw GR estado ("Vigente"/"Baja"/…) → canonical enum the FE understands.
        // Computed-on-read (same convention as deriveTechnology); idempotent for canonical values.
        status: mapContractStatus(s.status),
        technology: deriveTechnology(s.technology, s.plan),
        startDate: s.startDate,
        // contract-network-read — pass-through of the current node/AP assignment.
        networkSiteId: s.networkSiteId,
        networkSiteName: s.networkSiteName,
        accessPointId: s.accessPointId,
        accessPointName: s.accessPointName,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.limit,
      totalPages,
    };
  }
}
