/**
 * ouiVendor.test.ts — TDD
 *
 * Cubre:
 *   - c0:c9:e3 → 'TP-Link'
 *   - unknown prefix → null
 *   - normalization: separadores distintos, mayúsculas/minúsculas
 */
import { vendorFromMac } from '@application/use-cases/ouiVendor';

describe('vendorFromMac', () => {
  it('identifica c0:c9:e3 como TP-Link', () => {
    expect(vendorFromMac('c0:c9:e3:34:33:75')).toBe('TP-Link');
  });

  it('case insensitive — mayúsculas en prefijo', () => {
    expect(vendorFromMac('C0:C9:E3:34:33:75')).toBe('TP-Link');
  });

  it('soporta separador guion', () => {
    expect(vendorFromMac('c0-c9-e3-34-33-75')).toBe('TP-Link');
  });

  it('soporta MAC sin separador (hex puro)', () => {
    expect(vendorFromMac('c0c9e3343375')).toBe('TP-Link');
  });

  it('retorna null para OUI desconocido', () => {
    expect(vendorFromMac('00:00:00:01:02:03')).toBeNull();
  });

  it('retorna null para MAC vacía', () => {
    expect(vendorFromMac('')).toBeNull();
  });

  it('identifica Mikrotik', () => {
    // 4C:5E:0C es un OUI Mikrotik conocido
    const result = vendorFromMac('4c:5e:0c:aa:bb:cc');
    expect(result).toBe('MikroTik');
  });

  it('identifica Ubiquiti', () => {
    // 78:8A:20 es un OUI Ubiquiti/UBNT
    const result = vendorFromMac('78:8a:20:96:6a:ae');
    expect(result).toBe('Ubiquiti');
  });
});
