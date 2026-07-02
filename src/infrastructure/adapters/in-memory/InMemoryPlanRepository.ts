import { randomUUID } from 'crypto';
import { Plan } from '@domain/entities/plan';
import { PlanRepository, PlanUpsert } from '@domain/ports/PlanRepository';
import { PlanNotFoundError } from '@domain/errors/plan';

export class InMemoryPlanRepository implements PlanRepository {
  private readonly store: Plan[] = [];
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  async upsertByCode(data: PlanUpsert): Promise<Plan> {
    const existing = this.store.find(p => p.code === data.code);
    const ts = this.now().toISOString();
    if (existing) {
      if (data.name !== undefined) existing.name = data.name;
      if (data.category !== undefined) existing.category = data.category;
      if (data.downloadKbps !== undefined) existing.downloadKbps = data.downloadKbps;
      if (data.uploadKbps !== undefined) existing.uploadKbps = data.uploadKbps;
      if (data.status !== undefined) existing.status = data.status;
      existing.updatedAt = ts;
      return { ...existing };
    }
    const created: Plan = {
      id: randomUUID(),
      code: data.code,
      name: data.name,
      category: data.category,
      downloadKbps: data.downloadKbps,
      uploadKbps: data.uploadKbps,
      status: data.status ?? 'enabled',
      createdAt: ts,
      updatedAt: ts,
    };
    this.store.push(created);
    return { ...created };
  }

  async list(): Promise<Plan[]> {
    // Orden de inserción, deliberadamente SIN sort: espeja a Prisma (orden de DB).
    // El orden del catálogo lo aplica ListPlans (el port no garantiza orden).
    return this.store.map(p => ({ ...p }));
  }

  async findById(id: string): Promise<Plan | null> {
    const f = this.store.find(p => p.id === id);
    return f ? { ...f } : null;
  }

  async findByCode(code: string): Promise<Plan | null> {
    const f = this.store.find(p => p.code === code);
    return f ? { ...f } : null;
  }

  async delete(id: string): Promise<void> {
    const i = this.store.findIndex(p => p.id === id);
    if (i === -1) throw new PlanNotFoundError(id);
    this.store.splice(i, 1);
  }
}
