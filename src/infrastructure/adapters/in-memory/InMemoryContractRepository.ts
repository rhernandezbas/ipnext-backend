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
  /** #43 — manual `name` per contract id, exercised by updateName. */
  public names: Record<string, string | null> = {};
  /**
   * Fase 2b — GR `Contract.vendedor` per seeded contract. Not part of the wire
   * DTO (ContractListItem); kept as a parallel list so listDistinctVendedores
   * can mirror the Prisma adapter without leaking vendedor into the listing.
   */
  private vendedores: (string | null)[] = [];

  /** Test seam: seed a contract list item. Returns the generated id. */
  seed(data: Partial<ContractListItem> & { clientName: string; plan: string; vendedor?: string | null }): ContractListItem {
    const item: ContractListItem = {
      id: data.id ?? randomUUID(),
      code: data.code ?? null,
      clientId: data.clientId ?? randomUUID(),
      clientName: data.clientName,
      plan: data.plan,
      status: data.status ?? 'active',
      technology: data.technology ?? null,
      startDate: data.startDate ?? new Date().toISOString(),
    };
    this.items.push(item);
    this.vendedores.push(data.vendedor ?? null);
    if (!(item.id in this.names)) this.names[item.id] = null;
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

  async updateName(id: string, name?: string | null): Promise<{ id: string; name: string | null } | null> {
    if (!(id in this.names)) return null;
    // W-3 — undefined is a no-op: leave the stored name untouched.
    if (name !== undefined) this.names[id] = name;
    return { id, name: this.names[id] };
  }

  async listDistinctVendedores(): Promise<string[]> {
    const distinct = new Set<string>();
    for (const v of this.vendedores) {
      if (v !== null && v !== '') distinct.add(v);
    }
    return Array.from(distinct).sort((a, b) => a.localeCompare(b));
  }
}
