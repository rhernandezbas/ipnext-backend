/**
 * mapTaskStageToPortalStatus — customer-portal-api (Fase 4, task 4.4).
 *
 * Dominio puro (cero imports de infra/Prisma). Traduce el stage interno de una
 * ScheduledTask al estado publico que ve el cliente en la app: nunca el nombre
 * crudo del stage, ni tecnico/notas/materiales.
 *
 * `stageCategory`/`generalStatus` se reciben como `string` (no la union estricta
 * `StageCategory`/`TaskGeneralStatus`) a proposito: un valor futuro/desconocido no
 * debe romper el mapeo, debe caer al fallback conservador (spec "Stage interno sin
 * mapeo conocido").
 *
 * Por que `generalStatus` decide "cancelada" y no la categoria del stage: el stage
 * "Anulado-Cancelado" (prisma/seed.ts, code `anulado_cancelado`) tiene category
 * 'hecho' — la MISMA categoria que "Instalado"/"Hecho" (trabajo completado). La
 * categoria por si sola NUNCA puede distinguir "cancelada" de "completada"
 * (confirmado tambien por `DEFAULT_STAGE_ID_CANCELLED` en
 * InMemorySchedulingRepository.ts, que mapea a 'hecho' igual que
 * DEFAULT_STAGE_ID_COMPLETED). `generalStatus` SI es un eje independiente del
 * stage (comentario original en scheduling.ts: "lifecycle management state,
 * independent of workflow stage") y 'dismissed' ya significa, en el resto del
 * repo, "el operador la descarto" — la lectura mas honesta de "cancelada" desde
 * la perspectiva del cliente del portal.
 */
export type PortalTaskPublicStatus = 'agendada' | 'en_curso' | 'completada' | 'cancelada';

export interface TaskStageStatusInput {
  /** `Stage.category` de la ScheduledTask (StageCategory ensanchado a string). */
  stageCategory: string;
  /** `ScheduledTask.generalStatus` (TaskGeneralStatus ensanchado a string). */
  generalStatus: string;
}

export function mapTaskStageToPortalStatus(input: TaskStageStatusInput): PortalTaskPublicStatus {
  // 'dismissed' es un eje independiente del stage y gana siempre — una tarea
  // descartada por el operador es "cancelada" sin importar en que stage quedo.
  if (input.generalStatus === 'dismissed') {
    return 'cancelada';
  }

  switch (input.stageCategory) {
    case 'nuevo':
      return 'agendada';
    case 'enProgreso':
      return 'en_curso';
    case 'hecho':
      return 'completada';
    default:
      // Stage/categoria sin mapeo conocido — fallback conservador (spec).
      return 'en_curso';
  }
}
