import { parseIClassDateTime, formatIClassDateTime } from '@domain/services/iclassDateTime';

/**
 * IClass devuelve sus timestamps como "dd-MM-yyyy HH:mm:ss" en **hora de Argentina**
 * (verificado 2026-07-26: el último breadcrumb decía 09:08:32 mientras el reloj local
 * —Argentina— marcaba 09:13).
 *
 * El container de PROD corre en UTC (ver deploy.yml). Parsear con `new Date(...)` o
 * `getHours()` toma la TZ del proceso y desplaza 3 horas en prod: la ventana de trabajo
 * de una OS dejaría de contener los puntos correctos y la auditoría mentiría EN SILENCIO.
 * Es la misma clase de bug que rompió el password diario de Gestión Real.
 *
 * Argentina no aplica DST desde 2009 → offset fijo UTC-3.
 */
describe('parseIClassDateTime', () => {
  it('interprets the timestamp as Argentina time regardless of process TZ', () => {
    // 09:08:32 en Argentina (UTC-3) == 12:08:32 UTC
    const d = parseIClassDateTime('26-07-2026 09:08:32');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-07-26T12:08:32.000Z');
  });

  it('does NOT depend on the machine timezone offset', () => {
    // Si el parseo usara la TZ del proceso, este valor cambiaría entre dev (AR) y prod (UTC).
    const d = parseIClassDateTime('01-07-2026 20:29:02');
    expect(d!.toISOString()).toBe('2026-07-01T23:29:02.000Z');
  });

  it('parses the night-shift boundary that breaks naive UTC handling', () => {
    // 21:53 AR del 01-07 es 00:53 UTC del 02-07 — el día calendario CAMBIA en UTC.
    const d = parseIClassDateTime('01-07-2026 21:53:37');
    expect(d!.toISOString()).toBe('2026-07-02T00:53:37.000Z');
  });

  it('round-trips through formatIClassDateTime', () => {
    const raw = '26-07-2026 09:41:45';
    expect(formatIClassDateTime(parseIClassDateTime(raw)!)).toBe(raw);
  });

  it('returns null for malformed input instead of an Invalid Date', () => {
    expect(parseIClassDateTime('')).toBeNull();
    expect(parseIClassDateTime('2026-07-26 09:08:32')).toBeNull(); // ISO, no el formato de IClass
    expect(parseIClassDateTime('26/07/2026 09:08:32')).toBeNull();
    expect(parseIClassDateTime('basura')).toBeNull();
  });

  it('rejects impossible calendar values', () => {
    expect(parseIClassDateTime('32-07-2026 09:00:00')).toBeNull();
    expect(parseIClassDateTime('26-13-2026 09:00:00')).toBeNull();
    expect(parseIClassDateTime('26-07-2026 25:00:00')).toBeNull();
  });

  it('accepts a timestamp without seconds', () => {
    const d = parseIClassDateTime('26-07-2026 09:08');
    expect(d!.toISOString()).toBe('2026-07-26T12:08:00.000Z');
  });
});
