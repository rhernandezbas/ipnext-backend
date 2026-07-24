import { MappedStage } from '@domain/ports/TaskStageRecipientConfigRepository';
import { TaskStageTransitionConfigRepository } from '@domain/ports/TaskStageTransitionConfigRepository';
import { prisma } from '../../database/prisma';

/** Singleton row id — mirrors NocBroadcastConfig ('singleton'). */
const SINGLETON_ID = 'singleton';

/**
 * bulk-task-stage-transition (B1.5, D1) — Prisma adapter for the singleton
 * transition-config port. `setResultingStageId` is an UPSERT on the fixed id
 * (create-or-update the single row). `getResultingStage` hydrates via
 * `include: { resultingStage: { include: { workflow: true } } }`. An unknown/borrado
 * stage → `resultingStage` is null (FK SetNull ya lo habría limpiado), devolvemos null.
 */
export class PrismaTaskStageTransitionConfigRepository implements TaskStageTransitionConfigRepository {
  async getResultingStageId(): Promise<string | null> {
    const row = await prisma.whatsappTaskStageTransitionConfig.findUnique({
      where: { id: SINGLETON_ID },
      select: { resultingStageId: true },
    });
    return row?.resultingStageId ?? null;
  }

  async getResultingStage(): Promise<MappedStage | null> {
    const row = await prisma.whatsappTaskStageTransitionConfig.findUnique({
      where: { id: SINGLETON_ID },
      include: { resultingStage: { include: { workflow: true } } },
    });
    if (!row || !row.resultingStage) return null;
    return {
      stageId: row.resultingStage.id,
      stageName: row.resultingStage.name,
      stageCode: row.resultingStage.code,
      color: row.resultingStage.color,
      workflowId: row.resultingStage.workflowId,
      workflowName: row.resultingStage.workflow.name,
    };
  }

  async setResultingStageId(stageId: string | null): Promise<void> {
    await prisma.whatsappTaskStageTransitionConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, resultingStageId: stageId },
      update: { resultingStageId: stageId },
    });
  }
}
