/**
 * customer-portal-api (Fase 4, task 4.4) — "franja horaria" para GET /api/portal/tasks.
 *
 * Evidencia: `ScheduledTask` (prisma/schema.prisma) NO modela una franja horaria
 * dedicada — solo `startDate`/`endDate` (DateTime). design.md 7 autoriza el v1
 * conservador: "si no hay franja modelada, v1 muestra fecha + turno derivado
 * (mañana/tarde)". Derivamos manana|tarde de la HORA del `startDate`.
 *
 * Fix portal-timeslot-art: el caller real (`ListPortalTasks` via
 * `PrismaSchedulingRepository`, que serializa `row.startDate.toISOString()`) pasa
 * strings UTC (`...Z`). Parsear el substring "THH:" leia la hora UTC como si fuera
 * hora de pared ART: 10:00 ART llegaba como `T13:...Z` => 'tarde' (mal). La franja
 * se deriva ahora en la zona `America/Argentina/Buenos_Aires` REAL via
 * `Intl.DateTimeFormat`, asi que estos tests DEBEN pasar con cualquier TZ del
 * proceso (no dependen de process.env.TZ).
 */
import { derivePortalTaskTimeSlot } from '@domain/services/derivePortalTaskTimeSlot';

describe('derivePortalTaskTimeSlot — customer-portal-api Fase 4.4', () => {
  describe('strings UTC (caso real: PrismaSchedulingRepository serializa toISOString())', () => {
    it('2026-07-30T13:00:00.000Z = 10:00 ART -> mañana', () => {
      expect(derivePortalTaskTimeSlot('2026-07-30T13:00:00.000Z')).toBe('mañana');
    });

    it('2026-07-30T15:59:00.000Z = 12:59 ART -> mañana (borde inferior del corte)', () => {
      expect(derivePortalTaskTimeSlot('2026-07-30T15:59:00.000Z')).toBe('mañana');
    });

    it('2026-07-30T16:00:00.000Z = 13:00 ART -> tarde (corte exacto)', () => {
      expect(derivePortalTaskTimeSlot('2026-07-30T16:00:00.000Z')).toBe('tarde');
    });

    it('2026-07-31T00:30:00.000Z = 21:30 ART del 30/07 -> tarde (cruce de dia UTC)', () => {
      expect(derivePortalTaskTimeSlot('2026-07-31T00:30:00.000Z')).toBe('tarde');
    });
  });

  describe('strings con offset explicito (misma semantica: hora de pared ART)', () => {
    it('hora antes de las 13:00 ART -> mañana', () => {
      expect(derivePortalTaskTimeSlot('2026-07-30T09:00:00-03:00')).toBe('mañana');
      expect(derivePortalTaskTimeSlot('2026-08-01T08:30:00-03:00')).toBe('mañana');
      expect(derivePortalTaskTimeSlot('2026-08-01T12:59:00-03:00')).toBe('mañana');
    });

    it('hora 13:00 ART o despues -> tarde', () => {
      expect(derivePortalTaskTimeSlot('2026-08-01T13:00:00-03:00')).toBe('tarde');
      expect(derivePortalTaskTimeSlot('2026-08-01T18:45:00-03:00')).toBe('tarde');
    });
  });

  it('sin startDate (null) -> null (sin franja, tarea todavia sin agendar)', () => {
    expect(derivePortalTaskTimeSlot(null)).toBeNull();
  });

  it('string malformado -> null (defensivo, nunca revienta la ruta)', () => {
    expect(derivePortalTaskTimeSlot('no-es-una-fecha')).toBeNull();
  });
});
