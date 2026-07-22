import { randomUUID } from 'crypto';
import { ContractServiceView } from '@domain/entities/contract-service';
import { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import { ContractServiceDuplicateError } from '@domain/errors/contractServices';
import { cicFromNotes } from '@application/use-cases/gigared/reconcileTvContractService';

interface Row {
  id: string;
  contractId: string;
  serviceCatalogId: string;
  status: string;
  notes: string | null;
  tvLogin: string | null;
  tvPassword: string | null;
  createdAt: string;
  deactivatedAt: string | null;
}

/**
 * In-memory ContractServiceRepository for use-case and route tests.
 * The joined `name`/`label` come from the `catalog` seam — a map of
 * `serviceCatalogId → { name, label }`. Tests seed it to mirror ServiceCatalog.
 */
export class InMemoryContractServiceRepository implements ContractServiceRepository {
  private rows: Row[] = [];
  /** Test seam: catalog name/label keyed by serviceCatalogId, used to join the view. */
  public catalog: Record<string, { name: string; label: string | null }> = {};
  /**
   * gigared-tv-identity-hardening (D4) — test seam: contractId → clientId, mirrors the
   * Prisma adapter's `contract: { select: { clientId: true } }` JOIN. Used exclusively by
   * findActiveTvOwnersByCics; unseeded contractIds resolve to ''.
   */
  public contractClients: Record<string, string> = {};

  private toView(row: Row): ContractServiceView {
    const cat = this.catalog[row.serviceCatalogId];
    return {
      id: row.id,
      contractId: row.contractId,
      serviceCatalogId: row.serviceCatalogId,
      name: cat?.name ?? '',
      label: cat?.label ?? null,
      status: row.status,
      notes: row.notes,
      tvLogin: row.tvLogin,
      tvPassword: row.tvPassword,
      createdAt: row.createdAt,
      deactivatedAt: row.deactivatedAt,
    };
  }

  async getById(id: string): Promise<ContractServiceView | null> {
    const row = this.rows.find(r => r.id === id);
    return row ? this.toView(row) : null;
  }

  async getByPair(contractId: string, serviceCatalogId: string): Promise<ContractServiceView | null> {
    const row = this.rows.find(r => r.contractId === contractId && r.serviceCatalogId === serviceCatalogId);
    return row ? this.toView(row) : null;
  }

  async listByContract(contractId: string): Promise<ContractServiceView[]> {
    return this.rows
      .filter(r => r.contractId === contractId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(r => this.toView(r));
  }

  // service-transfer — mirror of the Prisma adapter: ALL the ACTIVE rows of the catalog whose
  // notes start with the prefix, oldest first (MEDIUM-1). The caller re-validates the exact cic
  // per row (prefix collision "CIC 123" vs "CIC 1234") and handles multi-row dirty data.
  async findActiveByCatalogAndNotesPrefix(serviceCatalogId: string, notesPrefix: string): Promise<ContractServiceView[]> {
    return this.rows
      .filter(r =>
        r.serviceCatalogId === serviceCatalogId &&
        r.status === 'active' &&
        typeof r.notes === 'string' &&
        r.notes.startsWith(notesPrefix),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(r => this.toView(r));
  }

  // gigared-tv-identity-hardening (D4/B4) — batch owner resolver for ListGigaredAccounts
  // local-first. Exact cic match (cicFromNotes, unlike the prefix scan above) — the caller
  // (ListGigaredAccounts) ALSO re-validates via cicFromNotes when building its lookup map, so
  // this exact filter is a harmless double-check, never a source of drift. ONE pass over rows,
  // no per-account query (N+1 FORBIDDEN — mirrors the Prisma adapter's single findMany).
  async findActiveTvOwnersByCics(serviceCatalogId: string, cics: string[]): Promise<{ notes: string; clientId: string }[]> {
    if (cics.length === 0) return [];
    const wanted = new Set(cics);
    return this.rows
      .filter(r =>
        r.serviceCatalogId === serviceCatalogId &&
        r.status === 'active' &&
        wanted.has(cicFromNotes(r.notes) ?? ''),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(r => ({ notes: r.notes ?? '', clientId: this.contractClients[r.contractId] ?? '' }));
  }

  async add(data: { contractId: string; serviceCatalogId: string; notes?: string | null; tvLogin?: string | null; tvPassword?: string | null }): Promise<ContractServiceView> {
    // Parity with the Prisma UNIQUE(contractId, serviceCatalogId): the Prisma adapter maps
    // P2002 → ContractServiceDuplicateError; the in-memory port must mirror that so tests
    // that rely on the seam catch the same race the production DB enforces.
    const exists = this.rows.some(
      r => r.contractId === data.contractId && r.serviceCatalogId === data.serviceCatalogId,
    );
    if (exists) throw new ContractServiceDuplicateError();
    const row: Row = {
      id: randomUUID(),
      contractId: data.contractId,
      serviceCatalogId: data.serviceCatalogId,
      status: 'active',
      notes: data.notes ?? null,
      tvLogin: data.tvLogin ?? null,
      tvPassword: data.tvPassword ?? null,
      createdAt: new Date().toISOString(),
      deactivatedAt: null,
    };
    this.rows.push(row);
    return this.toView(row);
  }

  async update(id: string, data: { status?: string; notes?: string | null; tvLogin?: string | null; tvPassword?: string | null }): Promise<ContractServiceView | null> {
    const row = this.rows.find(r => r.id === id);
    if (!row) return null;
    if (data.status !== undefined) {
      if (data.status === 'inactive' && row.status !== 'inactive') {
        row.deactivatedAt = new Date().toISOString();
      } else if (data.status === 'active') {
        row.deactivatedAt = null;
      }
      row.status = data.status;
    }
    if (data.notes !== undefined) row.notes = data.notes;
    if (data.tvLogin !== undefined) row.tvLogin = data.tvLogin;
    if (data.tvPassword !== undefined) row.tvPassword = data.tvPassword;
    return this.toView(row);
  }

  async delete(id: string): Promise<boolean> {
    const index = this.rows.findIndex(r => r.id === id);
    if (index === -1) return false;
    this.rows.splice(index, 1);
    return true;
  }
}
