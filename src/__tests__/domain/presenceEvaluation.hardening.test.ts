import { evaluatePresence, PRESENCE_DEFAULTS } from '@domain/services/presenceEvaluation';
import type { TeamLocationPoint } from '@domain/entities/team-location-point';

/**
 * Hallazgos 1.4 / 1.5 / 1.7 / 1.9 / 1.10 del review adversarial.
 *
 * Todos son la misma clase de defecto: el código emitía `FUERA_DE_SITIO` en situaciones
 * donde la evidencia NO alcanza. Cada test de acá representa una acusación injusta que
 * el código anterior producía.
 */

const p = (
  at: string,
  latitude: number,
  longitude: number,
  accuracyMeters: number | null = 10,
  teamLogin = 'IPNXANDYM',
): TeamLocationPoint => ({
  teamLogin,
  latitude,
  longitude,
  recordedAt: new Date(at),
  accuracyMeters,
  sources: [1],
});

const ADDR = { latitude: -34.70084, longitude: -59.32028 };
const WINDOW = { from: new Date('2026-07-01T23:00:00Z'), to: new Date('2026-07-02T00:00:00Z') };

const base = { address: ADDR, teamLogin: 'IPNXANDYM', window: WINDOW };

describe('1.4 — el punto se elige por la COTA INFERIOR (d − precisión), no por distancia cruda', () => {
  it('prefers a farther but less precise fix whose error margin reaches the address', () => {
    // Verificado numéricamente por el review:
    //   P1: 199,8 m con raio 8   → cota inferior 191,8 → NO alcanza el domicilio
    //   P2: 244,7 m con raio 100 → cota inferior 144,7 → SÍ es compatible
    // El código anterior elegía P1 (más cerca en crudo) y CONDENABA.
    const r = evaluatePresence({
      ...base,
      points: [
        p('2026-07-01T23:10:00Z', -34.6990425, -59.32028, 8),    // ~199,8 m
        p('2026-07-01T23:20:00Z', -34.6986432, -59.32028, 100),  // ~244,7 m
        p('2026-07-01T23:30:00Z', -34.6986432, -59.32028, 100),
      ],
    });

    expect(r.verdict).toBe('EN_SITIO');
    expect(r.closestAccuracyMeters).toBe(100);
  });

  it('reports the RAW distance as evidence even when the choice used the lower bound', () => {
    const r = evaluatePresence({
      ...base,
      points: [
        p('2026-07-01T23:10:00Z', -34.6990425, -59.32028, 8),
        p('2026-07-01T23:20:00Z', -34.6986432, -59.32028, 100),
        p('2026-07-01T23:30:00Z', -34.6986432, -59.32028, 100),
      ],
    });
    // La distancia cruda del punto elegido, sin descontar nada.
    expect(r.minDistanceMeters).toBeGreaterThan(200);
    expect(r.minDistanceMeters).toBeLessThan(300);
  });
});

describe('1.5 — piso de cobertura antes de condenar', () => {
  it('does NOT condemn on a single point', () => {
    // Un único fix a las 23:45 con el técnico ya saliendo no prueba que no estuvo a las 23:10.
    const r = evaluatePresence({
      ...base,
      points: [p('2026-07-01T23:45:00Z', -34.6152, -59.4234, 30)],
    });
    expect(r.verdict).toBe('NO_CONCLUYENTE');
    expect(r.reason).toMatch(/cobertura/i);
  });

  it('does NOT condemn when the window has a sampling GAP larger than the limit', () => {
    // Dos puntos lejos, pero con 40 minutos sin muestrear en el medio: el técnico pudo
    // haber ido y vuelto en ese hueco.
    const r = evaluatePresence({
      ...base,
      points: [
        p('2026-07-01T23:05:00Z', -34.6152, -59.4234, 20),
        p('2026-07-01T23:50:00Z', -34.6152, -59.4234, 20),
      ],
    });
    expect(r.verdict).toBe('NO_CONCLUYENTE');
    expect(r.reason).toMatch(/hueco|cobertura/i);
  });

  it('R1 — does NOT condemn when the WINDOW EDGES are unsampled', () => {
    // Probado en vivo por la re-review: una ventana con los tres puntos apretados al
    // final daba FUERA_DE_SITIO con largestGap=5, teniendo casi toda la ventana sin un
    // solo registro. El piso de cobertura subía el precio de la acusación injusta de
    // 1 punto a 3; no la eliminaba. El hueco relevante es el de la VENTANA, no el que
    // hay "entre puntos".
    const r = evaluatePresence({
      ...base,
      points: [
        p('2026-07-01T23:50:00Z', -34.6152, -59.4234, 30),
        p('2026-07-01T23:55:00Z', -34.6152, -59.4234, 30),
        p('2026-07-01T23:59:00Z', -34.6152, -59.4234, 30),
      ],
    });
    expect(r.verdict).toBe('NO_CONCLUYENTE');
    expect(r.largestCoverageGapMinutes).toBeGreaterThan(20);
  });

  it('DOES condemn with dense coverage and no gaps (the verified OS 4995 shape)', () => {
    const points = [];
    for (let i = 0; i <= 55; i += 5) {
      points.push(p(`2026-07-01T23:${String(i).padStart(2, '0')}:00Z`, -34.6152, -59.4234, 30));
    }
    const r = evaluatePresence({ ...base, points });
    expect(r.verdict).toBe('FUERA_DE_SITIO');
    expect(r.pointsEvaluated).toBe(12);
  });

  it('a SINGLE point at the address still PROVES presence (asymmetry is deliberate)', () => {
    // Probar presencia con un punto es válido: el dispositivo estuvo ahí.
    // Probar AUSENCIA con un punto no lo es. La asimetría es el corazón del change.
    const r = evaluatePresence({
      ...base,
      points: [p('2026-07-01T23:30:00Z', ADDR.latitude, ADDR.longitude, 9)],
    });
    expect(r.verdict).toBe('EN_SITIO');
  });
});

describe('1.7 — precisión DESCONOCIDA no puede condenar', () => {
  it('is NO_CONCLUYENTE when every far point has unknown accuracy', () => {
    const points = [];
    for (let i = 0; i <= 55; i += 5) {
      points.push(p(`2026-07-01T23:${String(i).padStart(2, '0')}:00Z`, -34.6152, -59.4234, null));
    }
    const r = evaluatePresence({ ...base, points });
    expect(r.verdict).toBe('NO_CONCLUYENTE');
    expect(r.reason).toMatch(/precisi/i);
  });

  it('an unknown-accuracy point AT the address still proves presence', () => {
    const r = evaluatePresence({
      ...base,
      points: [p('2026-07-01T23:30:00Z', ADDR.latitude, ADDR.longitude, null)],
    });
    expect(r.verdict).toBe('EN_SITIO');
  });

  it('treats a negative accuracy as unknown, never as a distance bonus', () => {
    const points = [];
    for (let i = 0; i <= 55; i += 5) {
      points.push(p(`2026-07-01T23:${String(i).padStart(2, '0')}:00Z`, -34.6152, -59.4234, -50));
    }
    const r = evaluatePresence({ ...base, points });
    expect(r.verdict).toBe('NO_CONCLUYENTE');
  });
});

describe('1.9 — sólo cuentan los puntos DE ESA cuadrilla', () => {
  it('ignores points belonging to another team', () => {
    const points = [];
    for (let i = 0; i <= 55; i += 5) {
      points.push(p(`2026-07-01T23:${String(i).padStart(2, '0')}:00Z`, -34.6152, -59.4234, 30, 'IPNXEMAV'));
    }
    const r = evaluatePresence({ ...base, points });
    // Ningún punto es de IPNXANDYM → no hay nada que evaluar.
    expect(r.verdict).toBe('NO_CONCLUYENTE');
    expect(r.pointsEvaluated).toBe(0);
  });
});

describe('1.10 — un punto corrupto no puede condenar', () => {
  it('discards points with non-finite coordinates instead of returning FUERA_DE_SITIO', () => {
    // NaN < NaN es false, así que el punto corrupto al frente del array nunca se
    // reemplazaba y NaN <= threshold daba false → condena.
    const points: TeamLocationPoint[] = [
      p('2026-07-01T23:05:00Z', NaN, NaN, 10),
      p('2026-07-01T23:10:00Z', ADDR.latitude, ADDR.longitude, 9),
    ];
    const r = evaluatePresence({ ...base, points });
    expect(r.verdict).toBe('EN_SITIO');
    expect(r.pointsEvaluated).toBe(1);
  });

  it('is NO_CONCLUYENTE when EVERY point is corrupt', () => {
    const r = evaluatePresence({
      ...base,
      points: [p('2026-07-01T23:05:00Z', NaN, -59.4, 10), p('2026-07-01T23:15:00Z', -34.6, NaN, 10)],
    });
    expect(r.verdict).toBe('NO_CONCLUYENTE');
    expect(r.pointsEvaluated).toBe(0);
  });
});

describe('1.12 — el motivo no afirma causas que el sistema no puede conocer', () => {
  it('does not claim the device was not reporting', () => {
    const r = evaluatePresence({ ...base, points: [] });
    expect(r.verdict).toBe('NO_CONCLUYENTE');
    expect(r.reason).not.toMatch(/pudo no estar reportando/i);
    expect(r.reason).toMatch(/no hay registros|sin datos/i);
  });
});

describe('defaults expuestos', () => {
  it('exposes the coverage floor as named defaults', () => {
    expect(PRESENCE_DEFAULTS.onSiteThresholdMeters).toBe(150);
    expect(PRESENCE_DEFAULTS.minPointsToCondemn).toBeGreaterThanOrEqual(2);
    expect(PRESENCE_DEFAULTS.maxCoverageGapMinutes).toBeGreaterThan(0);
  });
});
