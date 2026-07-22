import { TaskRecipientSource } from '@domain/ports/TaskRecipientSource';
import { prisma } from '../../database/prisma';

/**
 * bulk-task-recipients (B2.6, D2, D9 Open Question resuelta) — Prisma adapter for
 * the resolution port. Clase PROPIA (no un método de `PrismaSchedulingRepository`)
 * para no acoplar esta capability nueva a un repo grande existente — mismo criterio
 * D-pattern que el port narrow (`TaskRecipientSource`, separado de
 * `CustomerRepository`).
 */
export class PrismaTaskRecipientSource implements TaskRecipientSource {
  async listClientIdsByOpenTaskStages(stageIds: string[]): Promise<string[]> {
    const rows: { customerId: string | null }[] = await prisma.scheduledTask.findMany({
      where: { stageId: { in: stageIds }, customerId: { not: null }, isClosed: false },
      select: { customerId: true },
      distinct: ['customerId'],
    });
    return rows.map((row) => row.customerId as string);
  }

  async countOpenTasksWithoutCustomer(stageIds: string[]): Promise<number> {
    return prisma.scheduledTask.count({
      where: { stageId: { in: stageIds }, customerId: null, isClosed: false },
    });
  }
}
