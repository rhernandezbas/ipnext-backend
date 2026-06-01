import { randomUUID } from 'crypto';
import { PaginatedResult } from '@application/dto/pagination';
import {
  ContractRepository,
  ListContractsQuery,
  ContractListItem,
  ContractStats,
} from '@domain/ports/ContractRepository';

/**
 * In-memory ContractRepository for use-case and route tests.
 * Stores already-joined list items (contract + clientName) so tests can seed
 * fixtures without a Client store.
 */
export class InMemoryContractRepository implements ContractRepository {
  private items: ContractListItem[] = [];

  /** Test seam: seed a contract list item. Returns the generated id. */
  seed(data: Partial<ContractListItem> & { clientName: string; plan: string }): ContractListItem {
    const item: ContractListItem = {
      id: data.id ?? randomUUID(),
      clientName: data.clientName,
      plan: data.plan,
      status: data.status ?? 'active',
      technology: data.technology ?? null,
      startDate: data.startDate ?? new Date().toISOString(),
    };
    this.items.push(item);
    return item;
  }

  async list(query: ListContractsQuery): Promise<PaginatedResult<ContractListItem>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;

    let filtered = this.items.slice();

    if (query.status) {
      filtered = filtered.filter((s) => s.status === query.status);
    }
    if (query.technology) {
      filtered = filtered.filter((s) => s.technology === query.technology);
    }
    if (query.search) {
      const needle = query.search.toLowerCase();
      filtered = filtered.filter(
        (s) =>
          s.plan.toLowerCase().includes(needle) ||
          s.clientName.toLowerCase().includes(needle),
      );
    }

    // Stable order: by startDate descending (newest first), matching the Prisma adapter.
    filtered.sort((a, b) => (a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0));

    const total = filtered.length;
    const data = filtered.slice((page - 1) * limit, (page - 1) * limit + limit).map((s) => ({ ...s }));

    return { data, total, page, limit };
  }

  async stats(): Promise<ContractStats> {
    const byStatus: Record<string, number> = {};
    for (const item of this.items) {
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    }
    return { total: this.items.length, byStatus };
  }
}
