import { randomUUID } from 'crypto';
import { PaginatedResult } from '@application/dto/pagination';
import {
  ServiceRepository,
  ListServicesQuery,
  ServiceListItem,
} from '@domain/ports/ServiceRepository';

/**
 * In-memory ServiceRepository for use-case and route tests.
 * Stores already-joined list items (service + clientName) so tests can seed
 * fixtures without a Client store.
 */
export class InMemoryServiceRepository implements ServiceRepository {
  private items: ServiceListItem[] = [];

  /** Test seam: seed a service list item. Returns the generated id. */
  seed(data: Partial<ServiceListItem> & { clientName: string; plan: string }): ServiceListItem {
    const item: ServiceListItem = {
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

  async list(query: ListServicesQuery): Promise<PaginatedResult<ServiceListItem>> {
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
}
