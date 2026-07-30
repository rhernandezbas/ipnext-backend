import type { PortalTaskPublicStatus } from '@domain/services/mapPortalTaskStatus';
import type { PortalTaskTimeSlot } from '@domain/services/derivePortalTaskTimeSlot';

/**
 * PortalTaskDto — customer-portal-api (Fase 4, task 4.4 + fix wave M6).
 *
 * portal-self-service spec "Mis tareas": DTO MINIMO. `scheduledDate` es
 * `ScheduledTask.startDate` (fecha programada) o null si la visita aun no tiene
 * fecha asignada. `timeSlot` se deriva de la HORA de `startDate` (mañana/tarde —
 * ver `derivePortalTaskTimeSlot`, v1: no hay franja modelada en el schema).
 * `publicStatus` sale de `mapTaskStageToPortalStatus`. NUNCA tecnico asignado,
 * notas internas, materiales ni el nombre crudo del stage.
 *
 * M6: el campo se llama `timeSlot` (era `franja`) — el wire contract del portal
 * es 100% ingles camelCase; renombrado ANTES de que exista la app consumidora.
 * (Los VALORES 'mañana'/'tarde' siguen siendo los del dominio.)
 */
export interface PortalTaskDto {
  scheduledDate: string | null;
  timeSlot: PortalTaskTimeSlot | null;
  publicStatus: PortalTaskPublicStatus;
}
