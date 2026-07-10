import {
  RetirementOrderReader,
  RetirementTaskQuery,
  RetirementTaskResult,
} from '@domain/ports/RetirementOrderReader';

/**
 * Seeded task row — mirrors the ScheduledTask⋈Project slice the Prisma adapter
 * queries: task ids + contract/client links + the project's retirement flag.
 */
export interface SeededRetirementTask {
  id: string;
  contractId: string | null;
  clientId: string | null;
  allowsEquipmentRetirement: boolean;
}

export class InMemoryRetirementOrderReader implements RetirementOrderReader {
  private tasks: SeededRetirementTask[] = [];

  // ─── Test helpers ────────────────────────────────────────────────────────────

  seedTask(task: SeededRetirementTask): void {
    this.tasks.push(task);
  }

  reset(): void {
    this.tasks = [];
  }

  // ─── Port implementation ─────────────────────────────────────────────────────

  async hasRetirementTask(query: RetirementTaskQuery): Promise<RetirementTaskResult> {
    // Guard the empty-OR: no keys → never matches (mirror of the Prisma adapter).
    if (!query.contractId && !query.clientId) return { exists: false };

    // M4 — sin falsos positivos: la pata por cliente SOLO cuenta tasks SIN
    // contrato linkeado (una task de retiro de OTRO contrato no cubre esta baja).
    const hit = this.tasks.find(
      (t) =>
        t.allowsEquipmentRetirement &&
        ((query.contractId !== undefined && t.contractId === query.contractId) ||
          (query.clientId !== undefined && t.clientId === query.clientId && t.contractId === null)),
    );

    return hit ? { exists: true, taskId: hit.id } : { exists: false };
  }
}
