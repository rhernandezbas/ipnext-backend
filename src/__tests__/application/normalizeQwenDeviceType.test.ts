import { normalizeQwenDeviceType } from '@application/services/normalizeQwenDeviceType';

const BASE = new Set(['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS']);

describe('normalizeQwenDeviceType (Set-based)', () => {
  it('acepta los valores del set (case-insensitive, con trim)', () => {
    expect(normalizeQwenDeviceType('ONU', BASE)).toBe('ONU');
    expect(normalizeQwenDeviceType('onu', BASE)).toBe('ONU');
    expect(normalizeQwenDeviceType('  Antena ', BASE)).toBe('ANTENA');
    expect(normalizeQwenDeviceType('ROUTER', BASE)).toBe('ROUTER');
    expect(normalizeQwenDeviceType('REPETIDOR', BASE)).toBe('REPETIDOR');
    expect(normalizeQwenDeviceType('OTROS', BASE)).toBe('OTROS');
  });

  it('valor desconocido → null (NO OTROS)', () => {
    expect(normalizeQwenDeviceType('switch', BASE)).toBeNull();
    expect(normalizeQwenDeviceType('router-wifi', BASE)).toBeNull();
  });

  it('empty/null/undefined → null', () => {
    expect(normalizeQwenDeviceType('', BASE)).toBeNull();
    expect(normalizeQwenDeviceType(null, BASE)).toBeNull();
    expect(normalizeQwenDeviceType(undefined, BASE)).toBeNull();
  });

  it('acepta tipos dinámicos del catálogo (set extendido)', () => {
    const extended = new Set(['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS', 'CPE']);
    expect(normalizeQwenDeviceType('CPE', extended)).toBe('CPE');
    expect(normalizeQwenDeviceType('cpe', extended)).toBe('CPE');
    // tipo no en set extendido → null
    expect(normalizeQwenDeviceType('SWITCH', extended)).toBeNull();
  });
});
