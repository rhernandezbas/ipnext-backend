import {
  FiberAutoProvisionAttempt,
  FiberAutoProvisionAttemptRepository,
} from '@domain/ports/FiberAutoProvisionAttemptRepository';

/**
 * K3 (fiber-auto-watcher) — fake in-memory del registro de intentos.
 * Upsert por (taskId, onuSn), como el unique compuesto de la tabla real.
 */
export class InMemoryFiberAutoProvisionAttemptRepository implements FiberAutoProvisionAttemptRepository {
  private readonly rows = new Map<string, FiberAutoProvisionAttempt>();

  private key(taskId: string, onuSn: string): string {
    return `${taskId}::${onuSn}`;
  }

  async find(taskId: string, onuSn: string): Promise<FiberAutoProvisionAttempt | null> {
    const row = this.rows.get(this.key(taskId, onuSn));
    return row ? { ...row } : null;
  }

  async save(attempt: FiberAutoProvisionAttempt): Promise<void> {
    this.rows.set(this.key(attempt.taskId, attempt.onuSn), { ...attempt });
  }

  /** Test seam: todos los registros persistidos. */
  all(): FiberAutoProvisionAttempt[] {
    return [...this.rows.values()].map(r => ({ ...r }));
  }
}
