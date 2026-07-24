import { OpenTaskRow, TaskRecipientSource } from '@domain/ports/TaskRecipientSource';
import { prisma } from '../../database/prisma';

/**
 * bulk-task-recipients (B2.6, D2, D9 Open Question resuelta) + fix wave (F1, HIGH)
 * — Prisma adapter for the resolution port. Clase PROPIA (no un método de
 * `PrismaSchedulingRepository`) para no acoplar esta capability nueva a un repo
 * grande existente — mismo criterio D-pattern que el port narrow
 * (`TaskRecipientSource`, separado de `CustomerRepository`).
 *
 * fix wave (F1) — el predicado de "abierta" es `generalStatus: 'open'`, NUNCA el
 * flag legacy `isClosed`: una tarea `generalStatus:'dismissed'` tiene
 * `isClosed === false` (`messaging.ts:227-228`) — usar `isClosed` dejaba pasar
 * tareas DESCARTADAS como si fueran destinatarios válidos. Mismo criterio que
 * `PrismaFiberAutoProvisionTaskRepository.ts:16` (única otra query de tareas
 * "abiertas" del repo).
 */
export class PrismaTaskRecipientSource implements TaskRecipientSource {
  async listClientIdsByOpenTaskStages(stageIds: string[]): Promise<string[]> {
    const rows: { customerId: string | null }[] = await prisma.scheduledTask.findMany({
      where: { stageId: { in: stageIds }, customerId: { not: null }, generalStatus: 'open' },
      select: { customerId: true },
      distinct: ['customerId'],
    });
    return rows.map((row) => row.customerId as string);
  }

  async listOpenTasksByStages(stageIds: string[]): Promise<OpenTaskRow[]> {
    // bulk-task-stage-transition (D2) — UNA fila POR TAREA (NO distinct): un cliente con
    // 2 tareas en los stages pedidos devuelve 2 filas. `stageId` es el origen A (guard).
    const rows: { id: string; customerId: string | null; stageId: string }[] = await prisma.scheduledTask.findMany({
      where: { stageId: { in: stageIds }, customerId: { not: null }, generalStatus: 'open' },
      select: { id: true, customerId: true, stageId: true },
    });
    return rows.map((row) => ({
      taskId: row.id,
      clientId: row.customerId as string,
      fromStageId: row.stageId,
    }));
  }

  async countOpenTasksWithoutCustomer(stageIds: string[]): Promise<number> {
    return prisma.scheduledTask.count({
      where: { stageId: { in: stageIds }, customerId: null, generalStatus: 'open' },
    });
  }
}
