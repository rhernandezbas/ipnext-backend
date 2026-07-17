import {
  FiberAutoProvisionTaskRepository,
  FiberAutoProvisionCandidateTask,
} from '@domain/ports/FiberAutoProvisionTaskRepository';
import { FiberInstallTaskWriter } from '@application/use-cases/ProvisionFiberOnu';

/** Fila mínima de tarea para los tests del watcher. */
export interface InMemoryFiberTask {
  id: string;
  contractId: string | null;
  onuSerial: string | null;
  archivedAt: string | null;
  description: string | null;
  /**
   * H2 (fix wave) — lifecycle de la tarea. El fake DEBE replicar el filtro real:
   * solo las tareas ABIERTAS son candidatas. Ausente = 'open' (default de la DB).
   */
  generalStatus?: 'open' | 'closed' | 'dismissed';
}

/**
 * K3 (fiber-auto-watcher) — fake del acceso a tareas del watcher. Implementa
 * TAMBIÉN FiberInstallTaskWriter (el writer del bloque auditable de
 * ProvisionFiberOnu) sobre EL MISMO store: en los tests, las notas del watcher
 * y el bloque del use case aterrizan en la misma tarea — igual que en prod
 * (ambos adapters Prisma pegan contra ScheduledTask).
 */
export class InMemoryFiberAutoProvisionTaskRepository
  implements FiberAutoProvisionTaskRepository, FiberInstallTaskWriter
{
  tasks: InMemoryFiberTask[] = [];

  // ── FiberAutoProvisionTaskRepository ────────────────────────────────────────

  async listCandidates(): Promise<FiberAutoProvisionCandidateTask[]> {
    // Contrato del port: serial seteado + NO archivada + ABIERTA (H2: una tarea
    // cerrada con serial NO puede quedar armada para siempre). Filtro en el adapter,
    // FIEL al de PrismaFiberAutoProvisionTaskRepository.
    return this.tasks
      .filter(t =>
        t.onuSerial != null &&
        t.onuSerial !== '' &&
        t.archivedAt === null &&
        (t.generalStatus ?? 'open') === 'open',
      )
      .map(t => ({
        id: t.id,
        contractId: t.contractId,
        onuSerial: t.onuSerial as string,
        description: t.description,
      }));
  }

  async appendNote(taskId: string, note: string): Promise<void> {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) return; // best-effort, como el adapter Prisma
    task.description = task.description ? `${task.description}\n\n${note}` : note;
  }

  // ── FiberInstallTaskWriter (bloque auditable de ProvisionFiberOnu) ──────────

  async findLatestByContract(contractId: string): Promise<{ id: string; description: string | null } | null> {
    const task = [...this.tasks].reverse().find(t => t.contractId === contractId && t.archivedAt === null);
    return task ? { id: task.id, description: task.description } : null;
  }

  // M4 — lookup directo por id (el watcher audita en la tarea MATCHEADA).
  async findById(taskId: string): Promise<{ id: string; description: string | null } | null> {
    const task = this.tasks.find(t => t.id === taskId);
    return task ? { id: task.id, description: task.description } : null;
  }

  async updateDescription(taskId: string, description: string): Promise<void> {
    const task = this.tasks.find(t => t.id === taskId);
    if (task) task.description = description;
  }
}
