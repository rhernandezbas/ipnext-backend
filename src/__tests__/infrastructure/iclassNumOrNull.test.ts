import { parseServiceOrderSummary } from '@infrastructure/adapters/iclass/IClassClient';

/**
 * R5 de la re-review: `numOrNull` usaba `parseFloat`, que TRUNCA una coma decimal sin
 * error y sin NaN. IClass es lusófono y puede emitir `"-34,70084"` → `-34`.
 *
 * Eso son **78 km de desvío sobre el dato que DECIDE el veredicto** de presencia
 * (`addressLat`/`addressLng`), y `Number.isFinite(-34)` lo deja pasar por todos los
 * guards nuevos. El fix del hallazgo 1.8 había endurecido el parser de los breadcrumbs
 * y el guard de Null Island, pero NO el del domicilio — la mitad peligrosa.
 */
describe('parseServiceOrderSummary — coordenadas del domicilio', () => {
  const raw = (endereco: Record<string, unknown>) => ({
    id: 1,
    codigo: '4995',
    endereco,
  });

  it('parses a normal decimal point', () => {
    const so = parseServiceOrderSummary(raw({ latitude: -34.70084, longitude: -59.32028 }), 'IPNEXT INTERNET');
    expect(so.addressLat).toBeCloseTo(-34.70084, 5);
    expect(so.addressLng).toBeCloseTo(-59.32028, 5);
  });

  it('parses a DECIMAL COMMA instead of silently truncating it', () => {
    const so = parseServiceOrderSummary(
      raw({ latitude: '-34,70084', longitude: '-59,32028' }),
      'IPNEXT INTERNET',
    );
    // Con parseFloat esto daba -34 y -59: el domicilio se movía 78 km.
    expect(so.addressLat).toBeCloseTo(-34.70084, 5);
    expect(so.addressLng).toBeCloseTo(-59.32028, 5);
  });

  it('rejects garbage instead of truncating to a plausible-looking number', () => {
    const so = parseServiceOrderSummary(raw({ latitude: '34abc', longitude: 'x' }), 'IPNEXT INTERNET');
    // `parseFloat('34abc')` daba 34 — una coordenada válida en el golfo de Guinea.
    expect(so.addressLat).toBeNull();
    expect(so.addressLng).toBeNull();
  });

  it('keeps a legitimate 0 distinguishable from absent', () => {
    const so = parseServiceOrderSummary(raw({ latitude: 0, longitude: 0 }), 'IPNEXT INTERNET');
    // 0 NO se descarta acá: el guard de "Null Island" vive en el dominio, que es quien
    // decide que un (0,0) hace la orden NO_AUDITABLE.
    expect(so.addressLat).toBe(0);
    expect(so.addressLng).toBe(0);
  });
});
