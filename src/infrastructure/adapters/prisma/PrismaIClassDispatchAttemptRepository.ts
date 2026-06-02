/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: Uses `as any` on Prisma client calls because prisma generate has not
 * been run against the IClassDispatchAttempt model in this environment (no DB available).
 * The Dockerfile runs `prisma generate` in the build, so prod is correct.
 */
import { prisma } from '@infrastructure/database/prisma';
import type {
  IClassDispatchAttempt,
  RecordDispatchAttemptInput,
} from '@domain/entities/iclass-dispatch-attempt';
import type { IClassDispatchAttemptRepository } from '@domain/ports/IClassDispatchAttemptRepository';

type IClassDispatchAttemptRow = {
  id: string;
  taskId: string;
  outcome: string;
  errorCode: string | null;
  errorMessage: string | null;
  attemptedNodeCode: string | null;
  resolvedNodeCode: string | null;
  actorId: string | null;
  createdAt: Date;
};

function mapRow(row: IClassDispatchAttemptRow): IClassDispatchAttempt {
  return {
    id: row.id,
    taskId: row.taskId,
    outcome: row.outcome as IClassDispatchAttempt['outcome'],
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    attemptedNodeCode: row.attemptedNodeCode,
    resolvedNodeCode: row.resolvedNodeCode,
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PrismaIClassDispatchAttemptRepository
  implements IClassDispatchAttemptRepository
{
  constructor(private readonly db = prisma) {}

  async record(input: RecordDispatchAttemptInput): Promise<IClassDispatchAttempt> {
    const row = (await (this.db as any).iClassDispatchAttempt.create({
      data: {
        taskId: input.taskId,
        outcome: input.outcome,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        attemptedNodeCode: input.attemptedNodeCode ?? null,
        resolvedNodeCode: input.resolvedNodeCode ?? null,
        actorId: input.actorId ?? null,
      },
    })) as IClassDispatchAttemptRow;
    return mapRow(row);
  }

  async listByTask(taskId: string): Promise<IClassDispatchAttempt[]> {
    const rows = (await (this.db as any).iClassDispatchAttempt.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    })) as IClassDispatchAttemptRow[];
    return rows.map(mapRow);
  }
}
