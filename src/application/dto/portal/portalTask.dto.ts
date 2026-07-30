import type { PortalTaskPublicStatus } from '@domain/services/mapPortalTaskStatus';
import type { PortalTaskTimeSlot } from '@domain/services/derivePortalTaskTimeSlot';

/**
 * PortalTaskDto — customer-portal-api (Fase 4, task 4.4).
 *
 * portal-self-service spec "Mis tareas": DTO MINIMO. `scheduledDate` es
 * `ScheduledTask.startDate` (fecha programada) o null si la visita aun no tiene
 * fecha asignada. `franja` se deriva de la HORA de `startDate` (mañana/tarde —
 * ver `derivePortalTaskTimeSlot`, v1: no hay franja modelada en el schema).
 * `publicStatus` sale de `mapTaskStageToPortalStatus`. NUNCA tecnico asignado,
 * notas internas, materiales ni el nombre crudo del stage.
 */
export interface PortalTaskDto {
  scheduledDate: string | null;
  franja: PortalTaskTimeSlot | null;
  publicStatus: PortalTaskPublicStatus;
}
