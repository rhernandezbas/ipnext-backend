/**
 * customer-portal-api (Fase 4, task 4.4) — mapeo Stage -> estado publico del portal.
 *
 * Evidencia usada para el mapeo (NO inventado):
 *  - prisma/seed.ts (T-28 "mapa canonico name->code"): las 11 stages seedeadas tienen
 *    category 'nuevo' (nuevo/confirmado/pospuesta/no_factible/send_to_iclass/
 *    registered_in_iclass/notificado), 'enProgreso' (en_progreso), o 'hecho'
 *    (instalado/hecho/anulado_cancelado). El code "anulado_cancelado" (cancelacion)
 *    comparte category 'hecho' con "instalado"/"hecho" (completado) - la categoria
 *    SOLA no alcanza para distinguir cancelada de completada.
 *  - src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts
 *    (DEFAULT_STAGE_ID_CANCELLED -> deriveStageCategory devuelve 'hecho', mismo que
 *    DEFAULT_STAGE_ID_COMPLETED) confirma el mismo hallazgo desde el lado del fixture.
 *  - `ScheduledTask.generalStatus` ('open'|'closed'|'dismissed', #41) es un eje
 *    INDEPENDIENTE del stage (comentario propio: "lifecycle management state,
 *    independent of workflow stage"). grep de uso real de 'dismissed' confirma la
 *    semantica: "tarea DESCARTADA" / "el operador la descarto" (InMemoryTaskRecipientSource,
 *    fix-wave F1 tests) - exactamente "cancelada" desde la perspectiva del cliente.
 *
 * Decision: dismissed (generalStatus) tiene PRIORIDAD sobre stageCategory. Sin eso
 * jamas se puede exponer "cancelada" via categoria sola (evidencia de arriba).
 */
import { mapTaskStageToPortalStatus } from '@domain/services/mapPortalTaskStatus';

describe('mapTaskStageToPortalStatus — customer-portal-api Fase 4.4', () => {
  it('category nuevo -> agendada', () => {
    expect(mapTaskStageToPortalStatus({ stageCategory: 'nuevo', generalStatus: 'open' })).toBe('agendada');
  });

  it('category enProgreso -> en_curso', () => {
    expect(mapTaskStageToPortalStatus({ stageCategory: 'enProgreso', generalStatus: 'open' })).toBe('en_curso');
  });

  it('category hecho -> completada', () => {
    expect(mapTaskStageToPortalStatus({ stageCategory: 'hecho', generalStatus: 'closed' })).toBe('completada');
  });

  it('generalStatus dismissed (cualquier categoria) -> cancelada', () => {
    expect(mapTaskStageToPortalStatus({ stageCategory: 'hecho', generalStatus: 'dismissed' })).toBe('cancelada');
    expect(mapTaskStageToPortalStatus({ stageCategory: 'nuevo', generalStatus: 'dismissed' })).toBe('cancelada');
    expect(mapTaskStageToPortalStatus({ stageCategory: 'enProgreso', generalStatus: 'dismissed' })).toBe('cancelada');
  });

  it('scenario "Stage interno sin mapeo conocido" -> categoria desconocida cae a en_curso (fallback conservador)', () => {
    expect(mapTaskStageToPortalStatus({ stageCategory: 'algo-nuevo-del-futuro', generalStatus: 'open' })).toBe('en_curso');
  });

  it('generalStatus desconocido (dato corrupto/futuro) NO dispara cancelada — sigue la categoria', () => {
    expect(mapTaskStageToPortalStatus({ stageCategory: 'nuevo', generalStatus: 'algo-raro' })).toBe('agendada');
  });
});
