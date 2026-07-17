import {
  FiberAutoProvisionTaskRepository,
  FiberAutoProvisionCandidateTask,
} from '@domain/ports/FiberAutoProvisionTaskRepository';
import { prisma } from '../../database/prisma';

/**
 * K3 (fiber-auto-watcher) — acceso Prisma del watcher a las tareas.
 * Candidatas = onuSerial seteado + NO archivadas + ABIERTAS (índice
 * ScheduledTask_onuSerial_idx). H2 (fix wave): archivar es acción MANUAL — sin el
 * filtro por generalStatus una tarea cerrada con serial quedaba armada para siempre.
 */
export class PrismaFiberAutoProvisionTaskRepository implements FiberAutoProvisionTaskRepository {
  async listCandidates(): Promise<FiberAutoProvisionCandidateTask[]> {
    const rows = await (prisma as any).scheduledTask.findMany({
      where: { onuSerial: { not: null }, archivedAt: null, generalStatus: 'open' },
      select: { id: true, contractId: true, onuSerial: true, description: true },
    });
    return rows.map((r: any) => ({
      id: r.id,
      contractId: r.contractId ?? null,
      onuSerial: r.onuSerial as string,
      description: r.description ?? null,
    }));
  }

  async appendNote(taskId: string, note: string): Promise<void> {
    const row = await (prisma as any).scheduledTask.findUnique({
      where: { id: taskId },
      select: { description: true },
    });
    if (!row) return; // best-effort: tarea borrada entre el match y la nota
    const description = row.description ? `${row.description}\n\n${note}` : note;
    await (prisma as any).scheduledTask.update({ where: { id: taskId }, data: { description } });
  }
}
