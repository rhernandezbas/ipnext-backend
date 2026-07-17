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
    // Contrato del port: serial seteado + NO archivada (el filtro vive en el adapter).
    return this.tasks
      .filter(t => t.onuSerial != null && t.onuSerial !== '' && t.archivedAt === null)
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

  async updateDescription(taskId: string, description: string): Promise<void> {
    const task = this.tasks.find(t => t.id === taskId);
    if (task) task.description = description;
  }
}
