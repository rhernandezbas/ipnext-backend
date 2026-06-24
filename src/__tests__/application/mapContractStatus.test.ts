import { mapContractStatus } from '@application/use-cases/mapContractStatus';

describe('mapContractStatus', () => {
  // GR raw values → canonical enum ──────────────────────────────────────────
  it('maps "Vigente" → "active"', () => {
    expect(mapContractStatus('Vigente')).toBe('active');
  });

  it('maps "Activo" → "active"', () => {
    expect(mapContractStatus('Activo')).toBe('active');
  });

  it('maps "Baja" → "baja"', () => {
    expect(mapContractStatus('Baja')).toBe('baja');
  });

  it('maps "Inactivo" → "inactive"', () => {
    expect(mapContractStatus('Inactivo')).toBe('inactive');
  });

  it('maps "Suspendido" → "blocked"', () => {
    expect(mapContractStatus('Suspendido')).toBe('blocked');
  });

  it('maps "Bloqueado" → "blocked"', () => {
    expect(mapContractStatus('Bloqueado')).toBe('blocked');
  });

  it('maps "Pendiente de Instalación" → "new" (real GR value caught by the backfill guard)', () => {
    expect(mapContractStatus('Pendiente de Instalación')).toBe('new');
  });

  it('maps "Pendiente de Instalacion" (sin tilde) → "new"', () => {
    expect(mapContractStatus('Pendiente de Instalacion')).toBe('new');
  });

  it('maps "Pendiente" → "new"', () => {
    expect(mapContractStatus('Pendiente')).toBe('new');
  });

  // Normalization: case-insensitive + trimmed ────────────────────────────────
  it('is case-insensitive ("VIGENTE" → "active")', () => {
    expect(mapContractStatus('VIGENTE')).toBe('active');
  });

  it('is case-insensitive ("vigente" → "active")', () => {
    expect(mapContractStatus('vigente')).toBe('active');
  });

  it('trims surrounding whitespace ("  Baja  " → "baja")', () => {
    expect(mapContractStatus('  Baja  ')).toBe('baja');
  });

  it('handles mixed case + whitespace (" InActivo " → "inactive")', () => {
    expect(mapContractStatus(' InActivo ')).toBe('inactive');
  });

  // Already-canonical values pass through ─────────────────────────────────────
  it('passes through canonical "active"', () => {
    expect(mapContractStatus('active')).toBe('active');
  });

  it('passes through canonical "inactive"', () => {
    expect(mapContractStatus('inactive')).toBe('inactive');
  });

  it('passes through canonical "blocked"', () => {
    expect(mapContractStatus('blocked')).toBe('blocked');
  });

  it('passes through canonical "baja"', () => {
    expect(mapContractStatus('baja')).toBe('baja');
  });

  it('passes through canonical "new"', () => {
    expect(mapContractStatus('new')).toBe('new');
  });

  // Null / undefined / empty / unknown → safe default ────────────────────────
  it('returns "inactive" for null', () => {
    expect(mapContractStatus(null)).toBe('inactive');
  });

  it('returns "inactive" for undefined', () => {
    expect(mapContractStatus(undefined)).toBe('inactive');
  });

  it('returns "inactive" for empty string', () => {
    expect(mapContractStatus('')).toBe('inactive');
  });

  it('returns "inactive" for an unknown GR value', () => {
    // Silence the expected observability warn (asserted in its own describe block).
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mapContractStatus('Cualquiera')).toBe('inactive');
    warn.mockRestore();
  });

  // Accent / diacritic normalization (W2) ─────────────────────────────────────
  it('strips accents in matching ("Vígente" → "active")', () => {
    expect(mapContractStatus('Vígente')).toBe('active');
  });

  it('strips accents in matching ("Bájá" → "baja")', () => {
    expect(mapContractStatus('Bájá')).toBe('baja');
  });

  it('strips accents in matching ("inactívo" → "inactive")', () => {
    expect(mapContractStatus('inactívo')).toBe('inactive');
  });
});

// Observability of the fail-closed default (W2) ───────────────────────────────
describe('mapContractStatus — default observability', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns with the raw unrecognized value when it falls to the default', () => {
    expect(mapContractStatus('Estado Marciano')).toBe('inactive');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0].join(' ')).toContain('Estado Marciano');
  });

  it('does NOT warn for null (expected absence, not an unmapped value)', () => {
    expect(mapContractStatus(null)).toBe('inactive');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn for undefined', () => {
    expect(mapContractStatus(undefined)).toBe('inactive');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn for empty / whitespace-only string', () => {
    expect(mapContractStatus('   ')).toBe('inactive');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn for a recognized value', () => {
    expect(mapContractStatus('Vigente')).toBe('active');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
