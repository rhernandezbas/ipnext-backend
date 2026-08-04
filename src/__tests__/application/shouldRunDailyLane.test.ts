import {
  shouldRunDailyLane,
  DAILY_LANE_WINDOW_START_HOUR_AR,
  DAILY_LANE_WINDOW_END_HOUR_AR,
} from '@application/use-cases/shouldRunDailyLane';

/**
 * Argentina es UTC-3 todo el año (sin DST desde 2009), así que:
 *   03:30 ART == 06:30 UTC   ·   14:00 ART == 17:00 UTC   ·   00:30 ART == 03:30 UTC
 */
const utc = (iso: string) => new Date(iso);

describe('shouldRunDailyLane', () => {
  describe('LANE-2.1 — ventana horaria en hora ARGENTINA', () => {
    it('corre si está dentro de la ventana y nunca corrió', () => {
      expect(shouldRunDailyLane(null, utc('2026-08-04T06:30:00Z'))).toBe(true);
    });

    it('NO corre fuera de la ventana (14:00 ART)', () => {
      expect(shouldRunDailyLane(null, utc('2026-08-04T17:00:00Z'))).toBe(false);
    });

    it('NO corre si ya corrió HOY (mismo día calendario AR)', () => {
      const yaCorrio = utc('2026-08-04T06:05:00Z'); // 03:05 ART
      const ahora = utc('2026-08-04T06:30:00Z'); //    03:30 ART
      expect(shouldRunDailyLane(yaCorrio, ahora)).toBe(false);
    });

    it('corre si la última corrida fue AYER y estamos en ventana', () => {
      const ayer = utc('2026-08-03T06:05:00Z'); //  03:05 ART del 3
      const ahora = utc('2026-08-04T06:30:00Z'); // 03:30 ART del 4
      expect(shouldRunDailyLane(ayer, ahora)).toBe(true);
    });

    it('sigue habilitado en el último tick de la ventana (05:00 ART)', () => {
      expect(shouldRunDailyLane(null, utc('2026-08-04T08:00:00Z'))).toBe(true);
    });

    it('ya NO corre cuando la ventana cerró (06:00 ART)', () => {
      expect(shouldRunDailyLane(null, utc('2026-08-04T09:00:00Z'))).toBe(false);
    });

    // -------------------------------------------------------------------------
    // ESTE es el test que discrimina la implementación. El contenedor de prod
    // corre en UTC (gotcha documentado del password diario de GR). Una versión
    // hecha con `getHours()`/`getUTCHours()` daría TRUE acá, porque en UTC son
    // las 03:30 — pero en Argentina es medianoche y media, FUERA de la ventana.
    // -------------------------------------------------------------------------
    it('LANE-2.1 (TZ) — 03:30 UTC es 00:30 ART: NO corre', () => {
      expect(shouldRunDailyLane(null, utc('2026-08-04T03:30:00Z'))).toBe(false);
    });

    it('LANE-2.1 (TZ) — el "mismo día" se mide en calendario AR, no UTC', () => {
      // 2026-08-04T02:00:00Z es el 3 de agosto 23:00 en Argentina.
      // Un implementador que compare días en UTC creería que ya corrió "el 4".
      const corridaDel3 = utc('2026-08-04T02:00:00Z'); // 03-08 23:00 ART
      const ahoraDel4 = utc('2026-08-04T06:30:00Z'); //   04-08 03:30 ART
      expect(shouldRunDailyLane(corridaDel3, ahoraDel4)).toBe(true);
    });
  });

  describe('la ventana es de varias horas a propósito', () => {
    it('cubre más de un tick horario', () => {
      // Si el guard de exclusión le come el tick de las 3 porque el carril
      // rápido está en vuelo, todavía quedan las 4 y las 5. Con una ventana de
      // una sola hora, el carril lento podría saltearse días enteros en silencio.
      expect(DAILY_LANE_WINDOW_END_HOUR_AR - DAILY_LANE_WINDOW_START_HOUR_AR).toBeGreaterThanOrEqual(3);
    });
  });
});
