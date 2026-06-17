import { randomUUID } from 'crypto';
import { ServiceCutBatch } from '@domain/entities/serviceCutBatch';
import {
  ServiceCutBatchRepository,
  ServiceCutBatchCreate,
  ServiceCutBatchPatch,
} from '@domain/ports/ServiceCutBatchRepository';

/**
 * InMemoryServiceCutBatchRepository — test seam para ServiceCutBatchRepository (Fase C).
 * Map-backed por id. `now()` inyectable para createdAt/finishedAt deterministas en tests.
 */
export class InMemoryServiceCutBatchRepository implements ServiceCutBatchRepository {
  private readonly store = new Map<string, ServiceCutBatch>();
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  async create(data: ServiceCutBatchCreate): Promise<ServiceCutBatch> {
    const batch: ServiceCutBatch = {
      id: randomUUID(),
      action: data.action,
      status: 'pending',
      total: data.total,
      doneCount: 0,
      failedCount: 0,
      result: [],
      createdAt: this.now().toISOString(),
      finishedAt: null,
    };
    this.store.set(batch.id, batch);
    return { ...batch, result: [...batch.result] };
  }

  async findById(id: string): Promise<ServiceCutBatch | null> {
    const b = this.store.get(id);
    return b ? { ...b, result: b.result.map(r => ({ ...r })) } : null;
  }

  async update(id: string, patch: ServiceCutBatchPatch): Promise<ServiceCutBatch> {
    const b = this.store.get(id);
    if (!b) throw new Error(`ServiceCutBatch ${id} not found`);
    if (patch.status !== undefined) b.status = patch.status;
    if (patch.doneCount !== undefined) b.doneCount = patch.doneCount;
    if (patch.failedCount !== undefined) b.failedCount = patch.failedCount;
    if (patch.result !== undefined) b.result = patch.result.map(r => ({ ...r }));
    if (patch.finishedAt !== undefined) b.finishedAt = patch.finishedAt;
    return { ...b, result: b.result.map(r => ({ ...r })) };
  }
}
