import { mapStatus } from '../../infrastructure/adapters/prisma/PrismaClientMirrorRepository';

describe('PrismaClientMirrorRepository.mapStatus', () => {
  it('maps codigo 1 (Activo) to active', () => {
    expect(mapStatus('1')).toBe('active');
  });

  it('maps codigo 2 (Deudor) to late', () => {
    expect(mapStatus('2')).toBe('late');
  });

  it('maps codigo 3 (Inactivo) to inactive', () => {
    expect(mapStatus('3')).toBe('inactive');
  });

  it('maps codigo 4 (Incobrable) to blocked, never baja', () => {
    expect(mapStatus('4')).toBe('blocked');
  });

  it('maps codigo 6 (Baja) to baja, never inactive/blocked', () => {
    expect(mapStatus('6')).toBe('baja');
  });

  it('falls back to inactive for codigo 5 (unmapped)', () => {
    expect(mapStatus('5')).toBe('inactive');
  });

  it('falls back to inactive for null', () => {
    expect(mapStatus(null)).toBe('inactive');
  });
});
