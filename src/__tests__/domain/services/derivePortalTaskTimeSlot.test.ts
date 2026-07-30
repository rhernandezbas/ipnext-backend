/**
 * customer-portal-api (Fase 4, task 4.4) — "franja horaria" para GET /api/portal/tasks.
 *
 * Evidencia: `ScheduledTask` (prisma/schema.prisma) NO modela una franja horaria
 * dedicada — solo `startDate`/`endDate` (DateTime). design.md 7 autoriza el v1
 * conservador: "si no hay franja modelada, v1 muestra fecha + turno derivado
 * (mañana/tarde)". Derivamos manana|tarde de la HORA del `startDate`.
 *
 * Por que se parsea el string ISO en vez de `new Date(x).getHours()`: `startDate`
 * llega como "ISO 8601 with offset" (comentario en scheduling.ts) — el offset
 * embebido YA representa la hora de pared real del evento. `Date#getHours()`
 * convierte a la zona horaria del SERVIDOR (no necesariamente Argentina), lo cual
 * corrompería la franja si el proceso corre en UTC. Leer el substring "THH:" del
 * ISO da la hora de pared tal cual la escribio el caller, sin ninguna conversion.
 */
import { derivePortalTaskTimeSlot } from '@domain/services/derivePortalTaskTimeSlot';

describe('derivePortalTaskTimeSlot — customer-portal-api Fase 4.4', () => {
  it('hora antes de las 13:00 -> mañana', () => {
    expect(derivePortalTaskTimeSlot('2026-08-01T08:30:00-03:00')).toBe('mañana');
    expect(derivePortalTaskTimeSlot('2026-08-01T12:59:00-03:00')).toBe('mañana');
  });

  it('hora 13:00 o despues -> tarde', () => {
    expect(derivePortalTaskTimeSlot('2026-08-01T13:00:00-03:00')).toBe('tarde');
    expect(derivePortalTaskTimeSlot('2026-08-01T18:45:00-03:00')).toBe('tarde');
  });

  it('sin startDate (null) -> null (sin franja, tarea todavia sin agendar)', () => {
    expect(derivePortalTaskTimeSlot(null)).toBeNull();
  });

  it('string malformado -> null (defensivo, nunca revienta la ruta)', () => {
    expect(derivePortalTaskTimeSlot('no-es-una-fecha')).toBeNull();
  });
});
