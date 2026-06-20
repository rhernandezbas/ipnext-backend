import { randomUUID } from 'crypto';
import { PppoeService, EnforcedState } from '@domain/entities/pppoeService';
import { PppoeServiceRepository, PppoeServiceUpsert } from '@domain/ports/PppoeServiceRepository';

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
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  /** Test seam: asocia un contractId con el status de su cliente (para listByClientStatus). */
  setContractClientStatus(contractId: string, status: string): void {
    this.contractClientStatus.set(contractId, status);
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

  async setContractId(id: string, contractId: string): Promise<PppoeService | null> {
    const found = this.store.find(s => s.id === id);
    if (!found) return null;
    found.contractId = contractId;
    return { ...found };
  }

  async setEnforcedState(id: string, state: EnforcedState): Promise<PppoeService | null> {
    const found = this.store.find(s => s.id === id);
    if (!found) return null;
    found.enforcedState = state;
    return { ...found };
  }

  async listByClientStatus(status: string): Promise<PppoeService[]> {
    return this.store
      .filter(s => s.contractId !== null && this.contractClientStatus.get(s.contractId) === status)
      .map(s => ({ ...s }));
  }
}
