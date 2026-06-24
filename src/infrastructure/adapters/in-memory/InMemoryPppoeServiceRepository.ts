import { randomUUID } from 'crypto';
import { PppoeService, EnforcedState } from '@domain/entities/pppoeService';
import { PppoeServiceRepository, PppoeServiceUpsert, PppoeServiceWithClient } from '@domain/ports/PppoeServiceRepository';

/**
 * InMemoryPppoeServiceRepository — test seam para PppoeServiceRepository (pppoe-foundation + Fase C).
 * Array-backed. Upsert idempotente por `username`. `now()` inyectable.
 *
 * Fase C: `setEnforcedState` (no toca profile) + `listByClientStatus`. Como el repo de pppoe
 * no conoce Clients/Contracts, el cruce pppoe→client.status se siembra en tests con
 * `setContractClientStatus(contractId, status)` (test-only seam; en prod el JOIN lo hace Prisma).
 */
export class InMemoryPppoeServiceRepository implements PppoeServiceRepository {
  private readonly store: PppoeService[] = [];
  private readonly contractClientStatus = new Map<string, string>();
  private readonly contractClient = new Map<string, { clientId: string | null; customerName: string | null }>();
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  /** Test seam: asocia un contractId con el status de su cliente (para listByClientStatus). */
  setContractClientStatus(contractId: string, status: string): void {
    this.contractClientStatus.set(contractId, status);
  }

  /** Test seam: asocia un contractId con su cliente (clientId+customerName) para listAllPaginated. */
  setContractClient(contractId: string, clientId: string | null, customerName: string | null): void {
    this.contractClient.set(contractId, { clientId, customerName });
  }

  async upsertByUsername(data: PppoeServiceUpsert): Promise<PppoeService> {
    const existing = this.store.find(s => s.username === data.username);
    if (existing) {
      existing.password = data.password;
      existing.profile = data.profile ?? null;
      existing.remoteAddress = data.remoteAddress ?? null;
      existing.status = data.status ?? 'enabled';
      existing.nasId = data.nasId;
      existing.contractId = data.contractId ?? null;
      if (data.enforcedState !== undefined) existing.enforcedState = data.enforcedState;
      return { ...existing };
    }
    const created: PppoeService = {
      id: randomUUID(),
      username: data.username,
      password: data.password,
      profile: data.profile ?? null,
      remoteAddress: data.remoteAddress ?? null,
      status: data.status ?? 'enabled',
      nasId: data.nasId,
      contractId: data.contractId ?? null,
      enforcedState: data.enforcedState ?? 'active',
      callerId: null,
      createdAt: this.now().toISOString(),
    };
    this.store.push(created);
    return { ...created };
  }

  async list(): Promise<PppoeService[]> {
    return this.store.map(s => ({ ...s }));
  }

  async findById(id: string): Promise<PppoeService | null> {
    const found = this.store.find(s => s.id === id);
    return found ? { ...found } : null;
  }

  async findByUsername(username: string): Promise<PppoeService | null> {
    const found = this.store.find(s => s.username === username);
    return found ? { ...found } : null;
  }

  async findByContract(contractId: string): Promise<PppoeService[]> {
    return this.store.filter(s => s.contractId === contractId).map(s => ({ ...s }));
  }

  async findUnassigned(): Promise<PppoeService[]> {
    return this.store.filter(s => s.contractId === null).map(s => ({ ...s }));
  }

  async findAssigned(): Promise<PppoeService[]> {
    return this.store
      .filter(s => s.contractId !== null && s.remoteAddress !== null && s.status === 'enabled')
      .map(s => ({ ...s }));
  }

  async findByNasIdPaginated(params: {
    nasId: string;
    page: number;
    pageSize: number;
    username?: string;
    status?: string;
    enforcedState?: string;
  }): Promise<{ data: PppoeService[]; total: number }> {
    const { nasId, page, pageSize, username, status, enforcedState } = params;
    const usernameLower = username ? username.toLowerCase() : undefined;

    const filtered = this.store.filter(s => {
      if (s.nasId !== nasId) return false;
      if (usernameLower && !s.username.toLowerCase().includes(usernameLower)) return false;
      if (status && s.status !== status) return false;
      if (enforcedState && s.enforcedState !== enforcedState) return false;
      return true;
    });

    const sorted = [...filtered].sort((a, b) => a.username.localeCompare(b.username));

    const total = sorted.length;
    const skip  = (page - 1) * pageSize;
    const data  = sorted.slice(skip, skip + pageSize).map(s => ({ ...s }));

    return { data, total };
  }

  async findAssignedPaginated(params: {
    page: number;
    pageSize: number;
    search?: string;
    nasId?: string;
  }): Promise<{ data: PppoeService[]; total: number }> {
    const { page, pageSize, search, nasId } = params;
    const searchLower = search ? search.toLowerCase() : undefined;

    const filtered = this.store.filter(s => {
      if (s.contractId === null || s.remoteAddress === null || s.status !== 'enabled') return false;
      if (nasId && s.nasId !== nasId) return false;
      if (searchLower) {
        const matchUsername    = s.username.toLowerCase().includes(searchLower);
        const matchIp          = s.remoteAddress.toLowerCase().includes(searchLower);
        const matchContractId  = s.contractId.toLowerCase().includes(searchLower);
        if (!matchUsername && !matchIp && !matchContractId) return false;
      }
      return true;
    });

    // Stable order: username asc
    const sorted = [...filtered].sort((a, b) => a.username.localeCompare(b.username));

    const total = sorted.length;
    const skip  = (page - 1) * pageSize;
    const data  = sorted.slice(skip, skip + pageSize).map(s => ({ ...s }));

    return { data, total };
  }

  async listAllPaginated(params: {
    page: number;
    pageSize: number;
    search?: string;
    status?: string;
    nasId?: string;
  }): Promise<{ data: PppoeServiceWithClient[]; total: number }> {
    const { page, pageSize, search, status, nasId } = params;
    const searchLower = search ? search.toLowerCase() : undefined;

    // SECURITY: build the projection explicitly WITHOUT `password` (mirrors the Prisma `select`).
    // `{ ...s }` would copy the secret into the list object at runtime even though the type omits it.
    const withClient = (s: PppoeService): PppoeServiceWithClient => {
      const client = s.contractId ? this.contractClient.get(s.contractId) : undefined;
      return {
        id:            s.id,
        username:      s.username,
        profile:       s.profile,
        remoteAddress: s.remoteAddress,
        status:        s.status,
        enforcedState: s.enforcedState,
        nasId:         s.nasId,
        contractId:    s.contractId,
        callerId:      s.callerId,
        createdAt:     s.createdAt,
        clientId:      client?.clientId ?? null,
        customerName:  client?.customerName ?? null,
      };
    };

    const filtered = this.store.map(withClient).filter(s => {
      if (status && s.status !== status) return false;
      if (nasId && s.nasId !== nasId) return false;
      if (searchLower) {
        const matchUsername = s.username.toLowerCase().includes(searchLower);
        const matchClient = (s.customerName ?? '').toLowerCase().includes(searchLower);
        if (!matchUsername && !matchClient) return false;
      }
      return true;
    });

    const sorted = [...filtered].sort((a, b) => a.username.localeCompare(b.username));

    const total = sorted.length;
    const skip = (page - 1) * pageSize;
    const data = sorted.slice(skip, skip + pageSize).map(s => ({ ...s }));

    return { data, total };
  }

  async setContractId(id: string, contractId: string): Promise<PppoeService | null> {
    const found = this.store.find(s => s.id === id);
    if (!found) return null;
    found.contractId = contractId;
    return { ...found };
  }

  async clearContractId(id: string): Promise<PppoeService | null> {
    const found = this.store.find(s => s.id === id);
    if (!found) return null;
    found.contractId = null;
    return { ...found };
  }

  async setEnforcedState(id: string, state: EnforcedState): Promise<PppoeService | null> {
    const found = this.store.find(s => s.id === id);
    if (!found) return null;
    found.enforcedState = state;
    return { ...found };
  }

  async setCallerId(id: string, callerId: string): Promise<void> {
    const found = this.store.find(s => s.id === id);
    if (found) found.callerId = callerId;
  }

  async listByClientStatus(status: string): Promise<PppoeService[]> {
    return this.store
      .filter(s => s.contractId !== null && this.contractClientStatus.get(s.contractId) === status)
      .map(s => ({ ...s }));
  }
}
