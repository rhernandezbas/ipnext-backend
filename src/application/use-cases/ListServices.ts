import { ServiceRepository, ListServicesQuery } from '@domain/ports/ServiceRepository';
import { PaginatedContractsDto } from '../dto/contract.dto';

/**
 * Global paginated listing of services (contracts) for the contracts page.
 * Depends on the ServiceRepository port — never on Prisma.
 * Returns a DTO whose envelope matches the frontend PaginatedResponse exactly
 * ({ data, total, page, pageSize, totalPages }).
 */
export class ListServices {
  constructor(private readonly repo: ServiceRepository) {}

  async execute(query: ListServicesQuery): Promise<PaginatedContractsDto> {
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
        clientName: s.clientName,
        plan: s.plan,
        status: s.status,
        technology: s.technology,
        startDate: s.startDate,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.limit,
      totalPages,
    };
  }
}
