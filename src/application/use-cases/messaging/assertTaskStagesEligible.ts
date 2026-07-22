import type { TaskStageRecipientConfigRepository } from '@domain/ports/TaskStageRecipientConfigRepository';
import { TaskStageNotEligibleError } from '@domain/errors/messaging-bulk';

/**
 * bulk-task-recipients (B4.2, TASK-2, D3) — guard de elegibilidad del 5to
 * dominio de destinatarios "Tarea". Molde `assertHasRecipients.ts:16-24`.
 *
 * Vive FUERA de `resolveCombinedRecipients` (D3): la elegibilidad es
 * autoridad CROSS-dominio (la config gobierna qué puede tocar el resolver
 * compartido) — meterle el port de config-CRUD al resolver lo acoplaría a un
 * concern que no le corresponde. Lo invocan `PreviewCampaignSegment`/
 * `ListSegmentRecipients`/`CreateCampaign` ANTES de resolver clientes (5.3),
 * satisfaciendo TASK-2 ("422 ANTES de resolver clientes") en el punto de
 * ejecución del use case, no dentro del resolver.
 *
 * `taskStageIds` vacío es un no-op INMEDIATO — nunca toca `configRepo`, ni
 * siquiera exige que esté presente (una campaña sin el 5to dominio no debe
 * requerir wiring de esta capability).
 */
export async function assertTaskStagesEligible(
  taskStageIds: string[],
  configRepo?: TaskStageRecipientConfigRepository,
): Promise<void> {
  if (taskStageIds.length === 0) return;
  if (!configRepo) {
    // Defensivo — nunca ocurre en el wiring real (app.ts inyecta el repo Prisma).
    throw new Error('assertTaskStagesEligible: configRepo requerido para taskStageIds');
  }
  const mapped = new Set(await configRepo.listMappedStageIds());
  const ineligible = taskStageIds.filter((id) => !mapped.has(id));
  if (ineligible.length > 0) {
    throw new TaskStageNotEligibleError(ineligible);
  }
}
