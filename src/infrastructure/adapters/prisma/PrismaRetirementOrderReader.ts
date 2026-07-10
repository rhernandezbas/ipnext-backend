import {
  RetirementOrderReader,
  RetirementTaskQuery,
  RetirementTaskResult,
} from '@domain/ports/RetirementOrderReader';
import { prisma } from '../../database/prisma';

/**
 * actions-worklist (BAJA-1) — "does this baja already have a retirement order?"
 * ONE findFirst over ScheduledTask joined to Project (allowsEquipmentRetirement,
 * schema:1215). The task's client column is `customerId` (schema ScheduledTask).
 */
export class PrismaRetirementOrderReader implements RetirementOrderReader {
  async hasRetirementTask(query: RetirementTaskQuery): Promise<RetirementTaskResult> {
    // Guard the empty-OR: Prisma treats OR: [] as match-everything territory —
    // without keys this MUST be a no-match, never a full scan hit.
    const or: Array<Record<string, string | null>> = [];
    if (query.contractId) or.push({ contractId: query.contractId });
    // M4 — sin falsos positivos: la pata por cliente SOLO cuenta tasks SIN
    // contrato linkeado (una task de retiro de OTRO contrato no cubre esta baja).
    if (query.clientId) or.push({ customerId: query.clientId, contractId: null });
    if (or.length === 0) return { exists: false };

    const task = await prisma.scheduledTask.findFirst({
      where: {
        OR: or,
        project: { allowsEquipmentRetirement: true },
      },
      select: { id: true },
    });

    return task ? { exists: true, taskId: task.id } : { exists: false };
  }
}
