import { haversineMeters } from '@domain/services/haversine';

/**
 * Los pares de coordenadas de "casos reales" salen de la verificación en vivo contra la
 * API de IClass del 2026-07-26 (change iclass-gps-audit). Son la red de seguridad del
 * veredicto de presencia: si el cálculo de distancia se rompe, se rompe la auditoría.
 */
describe('haversineMeters', () => {
  it('is zero for the same point', () => {
    expect(haversineMeters(-34.65, -59.44, -34.65, -59.44)).toBe(0);
  });

  it('is symmetric', () => {
    const a = { lat: -34.5895283333, lon: -58.969065 };
    const b = { lat: -34.5895083333, lon: -58.9692116667 };
    expect(haversineMeters(a.lat, a.lon, b.lat, b.lon)).toBeCloseTo(
      haversineMeters(b.lat, b.lon, a.lat, a.lon),
      6,
    );
  });

  it('matches the verified OS 4862 pair (technician ~14 m from the address)', () => {
    // domicilio de la OS 4862 vs punto del técnico en la ventana de trabajo
    const d = haversineMeters(-34.5895283333, -58.969065, -34.5895083333, -58.9692116667);
    expect(d).toBeGreaterThan(12);
    expect(d).toBeLessThan(16);
  });

  it('resolves one degree of latitude to ~111.2 km', () => {
    const d = haversineMeters(-34.0, -59.0, -35.0, -59.0);
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  it('keeps sub-metre resolution for very close points', () => {
    // ~0.5 m de separación: el veredicto de "en sitio" se juega en metros, no en kilómetros
    const d = haversineMeters(-34.65, -59.44, -34.6500045, -59.44);
    expect(d).toBeGreaterThan(0.3);
    expect(d).toBeLessThan(0.7);
  });

  it('handles the OS 4995 order of magnitude (~12.9 km, far beyond any GPS error)', () => {
    // domicilio Tomas Jofre vs zona donde estuvo el dispositivo esa noche
    const d = haversineMeters(-34.70084, -59.32028, -34.6, -59.4);
    expect(d).toBeGreaterThan(10_000);
    expect(d).toBeLessThan(15_000);
  });
});
