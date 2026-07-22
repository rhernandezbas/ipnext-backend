import {
  MappedStage,
  TaskStageRecipientConfigRepository,
} from '@domain/ports/TaskStageRecipientConfigRepository';
import { TaskStageNotFoundError } from '@domain/errors/messaging-task-stage-config';
import { prisma } from '../../database/prisma';

interface MappedStageRow {
  stageId: string;
  stage: {
    name: string;
    code: string;
    color: string | null;
    workflowId: string;
    workflow: { name: string };
  };
}

/**
 * bulk-task-recipients (B2.5, D2) — Prisma adapter for the config-CRUD port.
 * `replaceMappedStages` is ATOMIC: `$transaction([deleteMany, createMany])` — if
 * `createMany` hits a FK violation (P2003, an unknown `stageId`), the WHOLE
 * transaction rolls back (the previous config is preserved, never a partial
 * replace) and the raw Prisma error is translated to `TaskStageNotFoundError`.
 */
export class PrismaTaskStageRecipientConfigRepository implements TaskStageRecipientConfigRepository {
  async listMappedStageIds(): Promise<string[]> {
    const rows: { stageId: string }[] = await prisma.whatsappTaskStageRecipientConfig.findMany({
      select: { stageId: true },
    });
    return rows.map((row) => row.stageId);
  }

  async getMappedStages(): Promise<MappedStage[]> {
    const rows: MappedStageRow[] = await prisma.whatsappTaskStageRecipientConfig.findMany({
      include: { stage: { include: { workflow: true } } },
    });
    return rows.map((row) => ({
      stageId: row.stageId,
      stageName: row.stage.name,
      stageCode: row.stage.code,
      color: row.stage.color,
      workflowId: row.stage.workflowId,
      workflowName: row.stage.workflow.name,
    }));
  }

  async replaceMappedStages(stageIds: string[]): Promise<void> {
    try {
      await prisma.$transaction([
        prisma.whatsappTaskStageRecipientConfig.deleteMany({}),
        prisma.whatsappTaskStageRecipientConfig.createMany({
          data: stageIds.map((stageId) => ({ stageId })),
        }),
      ]);
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2003') {
        throw new TaskStageNotFoundError();
      }
      throw err;
    }
  }
}
