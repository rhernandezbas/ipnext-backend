import type { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import type { PortalTaskDto } from '@application/dto/portal/portalTask.dto';
import { mapTaskStageToPortalStatus } from '@domain/services/mapPortalTaskStatus';
import { derivePortalTaskTimeSlot } from '@domain/services/derivePortalTaskTimeSlot';

/**
 * ListPortalTasks — customer-portal-api (Fase 4, task 4.4).
 *
 * portal-self-service spec "Mis tareas": SOLO las `ScheduledTask` del cliente
 * (`clientId` siempre del token). El DTO se arma EXCLUSIVAMENTE con
 * `startDate`/`stageCategory`/`generalStatus` — ningun otro campo de la entidad
 * (tecnico, notas, materiales, stage crudo) cruza hacia el use case's output.
 */
export class ListPortalTasks {
  constructor(private readonly scheduling: SchedulingRepository) {}

  async execute(clientId: string): Promise<PortalTaskDto[]> {
    const tasks = await this.scheduling.listTasks({ customerId: clientId });
    return tasks.map((t) => ({
      scheduledDate: t.startDate,
      franja: derivePortalTaskTimeSlot(t.startDate),
      publicStatus: mapTaskStageToPortalStatus({
        stageCategory: t.stageCategory,
        generalStatus: t.generalStatus,
      }),
    }));
  }
}
