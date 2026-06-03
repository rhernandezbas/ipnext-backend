import { normalizeQwenDeviceType } from '@application/services/normalizeQwenDeviceType';

describe('normalizeQwenDeviceType', () => {
  it('acepta los valores del enum (case-insensitive, con trim)', () => {
    expect(normalizeQwenDeviceType('ONU')).toBe('ONU');
    expect(normalizeQwenDeviceType('onu')).toBe('ONU');
    expect(normalizeQwenDeviceType('  Antena ')).toBe('ANTENA');
    expect(normalizeQwenDeviceType('ROUTER')).toBe('ROUTER');
    expect(normalizeQwenDeviceType('REPETIDOR')).toBe('REPETIDOR');
    expect(normalizeQwenDeviceType('OTROS')).toBe('OTROS');
  });

  it('valor desconocido → null (NO OTROS, para distinguir un match concreto del modelo)', () => {
    expect(normalizeQwenDeviceType('switch')).toBeNull();
    expect(normalizeQwenDeviceType('router-wifi')).toBeNull();
  });

  it('empty/null/undefined → null', () => {
    expect(normalizeQwenDeviceType('')).toBeNull();
    expect(normalizeQwenDeviceType(null)).toBeNull();
    expect(normalizeQwenDeviceType(undefined)).toBeNull();
  });
});
