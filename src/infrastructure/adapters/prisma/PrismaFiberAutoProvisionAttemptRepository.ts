import {
  FiberAutoProvisionAttempt,
  FiberAutoProvisionAttemptRepository,
  FiberAutoProvisionAttemptStatus,
} from '@domain/ports/FiberAutoProvisionAttemptRepository';
import { prisma } from '../../database/prisma';

function toAttempt(row: any): FiberAutoProvisionAttempt {
  return {
    taskId: row.taskId,
    onuSn: row.onuSn,
    attempts: row.attempts,
    status: row.status as FiberAutoProvisionAttemptStatus,
    lastError: row.lastError ?? null,
    lastAttemptAt: row.lastAttemptAt instanceof Date
      ? row.lastAttemptAt.toISOString()
      : (row.lastAttemptAt ?? null),
  };
}

/**
 * K3 (fiber-auto-watcher) — registro Prisma de intentos del watcher.
 * Upsert por el unique compuesto (taskId, onuSn) — sobrevive restarts.
 */
export class PrismaFiberAutoProvisionAttemptRepository implements FiberAutoProvisionAttemptRepository {
  async find(taskId: string, onuSn: string): Promise<FiberAutoProvisionAttempt | null> {
    const row = await (prisma as any).fiberAutoProvisionAttempt.findUnique({
      where: { taskId_onuSn: { taskId, onuSn } },
    });
    return row ? toAttempt(row) : null;
  }

  async save(attempt: FiberAutoProvisionAttempt): Promise<void> {
    const data = {
      attempts: attempt.attempts,
      status: attempt.status,
      lastError: attempt.lastError,
      lastAttemptAt: attempt.lastAttemptAt ? new Date(attempt.lastAttemptAt) : null,
    };
    await (prisma as any).fiberAutoProvisionAttempt.upsert({
      where: { taskId_onuSn: { taskId: attempt.taskId, onuSn: attempt.onuSn } },
      create: { taskId: attempt.taskId, onuSn: attempt.onuSn, ...data },
      update: data,
    });
  }
}
