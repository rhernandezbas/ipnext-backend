/**
 * conversation-events (Ola 2) — el bucketing de los reports se hace en hora local de
 * Argentina (UTC-3 fijo). Valores calendario HARDCODEADOS (oráculo independiente): un
 * instante UTC cerca de medianoche cae el día ANTERIOR en AR.
 */
import { toArgentinaDowHour, toArgentinaDateKey, ARGENTINA_UTC_OFFSET_HOURS } from '@application/use-cases/messaging/reportsTimezone';

describe('reportsTimezone (Argentina UTC-3)', () => {
  it('offset fijo -3', () => {
    expect(ARGENTINA_UTC_OFFSET_HOURS).toBe(-3);
  });

  it('mediodía UTC → 09:00 AR, mismo día (miércoles 2026-07-15)', () => {
    // 2026-07-15 es miércoles (dow 3). 12:00Z - 3h = 09:00 AR.
    expect(toArgentinaDowHour('2026-07-15T12:00:00.000Z')).toEqual({ dow: 3, hour: 9 });
    expect(toArgentinaDateKey('2026-07-15T12:00:00.000Z')).toBe('2026-07-15');
  });

  it('01:30 UTC → 22:30 AR del día ANTERIOR (martes 2026-07-14)', () => {
    // 01:30Z - 3h = 22:30 del 2026-07-14 (martes, dow 2). Prueba el roll-back de día.
    expect(toArgentinaDowHour('2026-07-15T01:30:00.000Z')).toEqual({ dow: 2, hour: 22 });
    expect(toArgentinaDateKey('2026-07-15T01:30:00.000Z')).toBe('2026-07-14');
  });
});
