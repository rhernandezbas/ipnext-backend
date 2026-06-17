import { randomUUID } from 'crypto';
import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository, PppoeServiceUpsert } from '@domain/ports/PppoeServiceRepository';

/**
 * InMemoryPppoeServiceRepository — test seam para PppoeServiceRepository (pppoe-foundation).
 * Array-backed. Upsert idempotente por `username`. `now()` inyectable.
 */
export class InMemoryPppoeServiceRepository implements PppoeServiceRepository {
  private readonly store: PppoeService[] = [];
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
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
}
