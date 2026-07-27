import { evaluatePresence, PRESENCE_DEFAULTS } from '@domain/services/presenceEvaluation';
import type { TeamLocationPoint } from '@domain/entities/team-location-point';

const point = (
  at: string,
  latitude: number,
  longitude: number,
  accuracyMeters = 10,
): TeamLocationPoint => ({
  teamLogin: 'IPNXANDYM',
  latitude,
  longitude,
  recordedAt: new Date(at),
  accuracyMeters,
  sources: [1],
});

const WINDOW = { from: new Date('2026-07-01T23:14:02Z'), to: new Date('2026-07-01T23:46:18Z') };

describe('evaluatePresence', () => {
  describe('NO_AUDITABLE — structural impossibility', () => {
    it('is NO_AUDITABLE when the address has no coordinates', () => {
      const r = evaluatePresence({ address: null, teamLogin: 'IPNXANDYM', window: WINDOW, points: [] });
      expect(r.verdict).toBe('NO_AUDITABLE');
      expect(r.reason).toMatch(/domicilio/i);
    });

    it('is NO_AUDITABLE when no team is assigned', () => {
      const r = evaluatePresence({
        address: { latitude: -34.7, longitude: -59.3 },
        teamLogin: null,
        window: WINDOW,
        points: [],
      });
      expect(r.verdict).toBe('NO_AUDITABLE');
      expect(r.reason).toMatch(/cuadrilla/i);
    });

    it('is NO_AUDITABLE when the order has no execution window', () => {
      const r = evaluatePresence({
        address: { latitude: -34.7, longitude: -59.3 },
        teamLogin: 'IPNXANDYM',
        window: null,
        points: [],
      });
      expect(r.verdict).toBe('NO_AUDITABLE');
      expect(r.reason).toMatch(/ventana/i);
    });
  });

  describe('NO_CONCLUYENTE — absence of data is NOT data of absence', () => {
    it('is NO_CONCLUYENTE when there are no points at all in the window', () => {
      const r = evaluatePresence({
        address: { latitude: -34.7, longitude: -59.3 },
        teamLogin: 'IPNXANDYM',
        window: WINDOW,
        points: [],
      });
      expect(r.verdict).toBe('NO_CONCLUYENTE');
      expect(r.verdict).not.toBe('FUERA_DE_SITIO');
      expect(r.pointsEvaluated).toBe(0);
    });

    it('is NO_CONCLUYENTE when points exist but all fall OUTSIDE the window', () => {
      // el técnico reportó ese día, pero no en la franja de trabajo → no se puede concluir
      const r = evaluatePresence({
        address: { latitude: -34.7, longitude: -59.3 },
        teamLogin: 'IPNXANDYM',
        window: WINDOW,
        points: [point('2026-07-01T15:29:05Z', -34.62, -59.4)],
      });
      expect(r.verdict).toBe('NO_CONCLUYENTE');
      expect(r.pointsEvaluated).toBe(0);
    });
  });

  describe('EN_SITIO', () => {
    it('is EN_SITIO when the closest point is at the address', () => {
      const r = evaluatePresence({
        address: { latitude: -34.59984965, longitude: -59.41964047 },
        teamLogin: 'IPNXANDYM',
        window: { from: new Date('2026-07-01T15:00:00Z'), to: new Date('2026-07-01T16:00:00Z') },
        points: [point('2026-07-01T15:23:37Z', -34.59984965, -59.41964047, 9.2)],
      });
      expect(r.verdict).toBe('EN_SITIO');
      expect(r.minDistanceMeters).toBeCloseTo(0, 1);
      expect(r.pointsEvaluated).toBe(1);
    });

    it('picks the CLOSEST point, not the first or the last', () => {
      const addr = { latitude: -34.65662374, longitude: -59.42687936 };
      const r = evaluatePresence({
        address: addr,
        teamLogin: 'IPNXANDYM',
        window: { from: new Date('2026-07-01T20:00:00Z'), to: new Date('2026-07-01T22:00:00Z') },
        points: [
          point('2026-07-01T20:44:12Z', -34.7, -59.5),
          point('2026-07-01T21:18:38Z', -34.65662, -59.426882, 10.5), // el más cercano
          point('2026-07-01T21:30:00Z', -34.68, -59.48),
        ],
      });
      expect(r.verdict).toBe('EN_SITIO');
      expect(r.minDistanceMeters).toBeLessThan(10);
      expect(r.pointsEvaluated).toBe(3);
      expect(r.closestPointAt?.toISOString()).toBe('2026-07-01T21:18:38.000Z');
    });
  });

  describe('GPS accuracy is subtracted before condemning', () => {
    it('does NOT condemn a low-accuracy fix near the threshold', () => {
      // 180 m de distancia con raio 102 m → el margen de error abarca el umbral de 150 m.
      // OJO: la versión anterior de este test pasaba `teamLogin: 'IPNXEMAV'` mientras el
      // helper `point()` construye puntos de 'IPNXANDYM'. Nadie lo notó porque el código
      // no filtraba por cuadrilla (hallazgo 1.9). Ahora sí filtra, así que el test
      // ejercía otra cosa de la que creía.
      const r = evaluatePresence({
        address: { latitude: -34.7, longitude: -59.3 },
        teamLogin: 'IPNXANDYM',
        window: { from: new Date('2026-07-01T12:00:00Z'), to: new Date('2026-07-01T13:00:00Z') },
        points: [point('2026-07-01T12:30:00Z', -34.7016182, -59.3, 102.5)],
      });
      expect(r.minDistanceMeters).toBeGreaterThan(150);
      expect(r.minDistanceMeters).toBeLessThan(210);
      expect(r.verdict).toBe('EN_SITIO');
      expect(r.closestAccuracyMeters).toBe(102.5);
    });

    it('DOES condemn when the distance dwarfs any plausible accuracy', () => {
      // Requiere COBERTURA (hallazgo 1.5): un solo punto ya no alcanza para condenar,
      // por más lejos que esté. Se usa una serie densa, como la de la OS 4995 real.
      const points = [
        point('2026-07-01T23:20:00Z', -34.6, -59.4, 31.8),
        point('2026-07-01T23:30:00Z', -34.6, -59.4, 31.8),
        point('2026-07-01T23:40:00Z', -34.6, -59.4, 31.8),
      ];
      const r = evaluatePresence({
        address: { latitude: -34.70084, longitude: -59.32028 },
        teamLogin: 'IPNXANDYM',
        window: WINDOW,
        points,
      });
      expect(r.verdict).toBe('FUERA_DE_SITIO');
      expect(r.minDistanceMeters).toBeGreaterThan(10_000);
    });
  });

  describe('verified real cases — regression net for the audit', () => {
    it('OS 4943: technician at the address (0 m) → EN_SITIO', () => {
      const r = evaluatePresence({
        address: { latitude: -34.59984965, longitude: -59.41964047 },
        teamLogin: 'IPNXANDYM',
        window: { from: new Date('2026-07-01T15:00:00Z'), to: new Date('2026-07-01T16:00:00Z') },
        points: [
          point('2026-07-01T15:18:37Z', -34.5998, -59.41955, 9.98),
          point('2026-07-01T15:22:27Z', -34.59984965, -59.41964047, 9.23),
          point('2026-07-01T15:23:37Z', -34.59984965, -59.41964047, 9.23),
        ],
      });
      expect(r.verdict).toBe('EN_SITIO');
      expect(r.minDistanceMeters).toBeCloseTo(0, 1);
    });

    it('OS 4905: the single-point method said 1538 m — the full trail says 3 m → EN_SITIO', () => {
      // Este es el FALSO NEGATIVO que motiva la regla "un punto nunca es prueba de ausencia".
      const r = evaluatePresence({
        address: { latitude: -34.65662374, longitude: -59.42687936 },
        teamLogin: 'IPNXANDYM',
        window: { from: new Date('2026-07-01T20:30:00Z'), to: new Date('2026-07-01T21:30:00Z') },
        points: [
          point('2026-07-01T20:44:12Z', -34.656615, -59.426888, 18.4),   // 9 m
          point('2026-07-01T21:08:39Z', -34.6566205, -59.4268855, 32.5), // 6 m
          point('2026-07-01T21:18:38Z', -34.6566255, -59.4268805, 10.5), // 3 m
        ],
      });
      expect(r.verdict).toBe('EN_SITIO');
      expect(r.minDistanceMeters).toBeLessThan(10);
      expect(r.minDistanceMeters).not.toBeGreaterThan(1000);
    });

    it('OS 4995: 16 points in the window, none closer than 12.8 km → FUERA_DE_SITIO', () => {
      const address = { latitude: -34.70084, longitude: -59.32028 };
      // franja 19:30-21:30 AR del 01-07 == 22:30-00:30 UTC; distancias reales ~12,87-12,90 km
      const points = [
        point('2026-07-01T23:23:37Z', -34.6152, -59.4234, 45.5),
        point('2026-07-01T23:33:39Z', -34.6152, -59.4234, 31.8),
        point('2026-07-01T23:43:39Z', -34.6152, -59.4234, 67.5),
      ];
      const r = evaluatePresence({ address, teamLogin: 'IPNXANDYM', window: WINDOW, points });
      expect(r.verdict).toBe('FUERA_DE_SITIO');
      expect(r.minDistanceMeters).toBeGreaterThan(10_000);
      expect(r.pointsEvaluated).toBe(3);
    });
  });

  describe('evidence is always returned', () => {
    it('returns full evidence alongside every conclusive verdict', () => {
      const r = evaluatePresence({
        address: { latitude: -34.70084, longitude: -59.32028 },
        teamLogin: 'IPNXANDYM',
        window: WINDOW,
        points: [
          point('2026-07-01T23:23:37Z', -34.6152, -59.4234, 45.5),
          point('2026-07-01T23:33:39Z', -34.6152, -59.4234, 31.8),
          point('2026-07-01T23:43:39Z', -34.6152, -59.4234, 67.5),
        ],
      });
      expect(r.minDistanceMeters).not.toBeNull();
      expect(r.closestPointAt).not.toBeNull();
      // Los tres puntos están a la misma distancia cruda; se elige el de MAYOR `raio`
      // porque es el de menor cota inferior `d − precisión` (hallazgo 1.4). Es el que
      // más favorece al técnico, y por eso es el correcto para decidir.
      expect(r.closestAccuracyMeters).toBe(67.5);
      expect(r.pointsEvaluated).toBe(3);
      expect(r.window).toEqual(WINDOW);
      expect(r.mapsUrl).toContain('google.com/maps');
    });

    it('never returns a maps link when there is no point to link to', () => {
      const r = evaluatePresence({
        address: { latitude: -34.7, longitude: -59.3 },
        teamLogin: 'IPNXANDYM',
        window: WINDOW,
        points: [],
      });
      expect(r.mapsUrl).toBeNull();
      expect(r.minDistanceMeters).toBeNull();
      expect(r.closestPointAt).toBeNull();
    });
  });

  describe('defaults', () => {
    it('exposes the on-site threshold as a named default', () => {
      expect(PRESENCE_DEFAULTS.onSiteThresholdMeters).toBe(150);
    });

    it('honours a custom threshold', () => {
      const input = {
        address: { latitude: -34.7, longitude: -59.3 },
        teamLogin: 'IPNXANDYM',
        window: { from: new Date('2026-07-01T12:00:00Z'), to: new Date('2026-07-01T13:00:00Z') },
        // Serie densa: condenar exige cobertura (hallazgo 1.5).
        points: [
          point('2026-07-01T12:20:00Z', -34.7027, -59.3, 1), // ~300 m
          point('2026-07-01T12:30:00Z', -34.7027, -59.3, 1),
          point('2026-07-01T12:40:00Z', -34.7027, -59.3, 1),
        ],
      };
      expect(evaluatePresence({ ...input }).verdict).toBe('FUERA_DE_SITIO');
      expect(evaluatePresence({ ...input, onSiteThresholdMeters: 500 }).verdict).toBe('EN_SITIO');
    });
  });
});
