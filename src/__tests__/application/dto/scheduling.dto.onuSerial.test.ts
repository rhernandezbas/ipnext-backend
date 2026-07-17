/**
 * K3 (fiber-auto-watcher) — contrato Zod del campo onuSerial en UpdateTaskSchema.
 *
 * Reglas:
 *  - 8-24 caracteres alfanuméricos TRAS normalizar (UPPERCASE, sin espacios).
 *  - NO exige prefijo HWTC al guardar: una ZTE/VSOL se registra igual
 *    (el watcher solo auto-aprovisiona Huawei — la policy vive en el use case).
 *  - null = limpiar el serial; omitido = no tocar.
 */
import { UpdateTaskSchema } from '@application/dto/scheduling.dto';

describe('UpdateTaskSchema — onuSerial (K3 fiber-auto-watcher)', () => {
  it('acepta un serial válido y lo NORMALIZA: uppercase, sin espacios', () => {
    const parsed = UpdateTaskSchema.parse({ onuSerial: 'hwtc 1111 2222' });
    expect(parsed.onuSerial).toBe('HWTC11112222');
  });

  it('un serial ya canónico pasa intacto', () => {
    const parsed = UpdateTaskSchema.parse({ onuSerial: 'HWTC11112222' });
    expect(parsed.onuSerial).toBe('HWTC11112222');
  });

  it('NO exige prefijo HWTC: una ONU ZTE/VSOL se registra igual', () => {
    const parsed = UpdateTaskSchema.parse({ onuSerial: 'ZTEGC1234567' });
    expect(parsed.onuSerial).toBe('ZTEGC1234567');
  });

  it('null = limpiar el serial (pasa)', () => {
    const parsed = UpdateTaskSchema.parse({ onuSerial: null });
    expect(parsed.onuSerial).toBeNull();
  });

  it('omitido → undefined (el PUT no toca el campo)', () => {
    const parsed = UpdateTaskSchema.parse({});
    expect(parsed.onuSerial).toBeUndefined();
  });

  it('rechaza <8 caracteres tras normalizar', () => {
    expect(UpdateTaskSchema.safeParse({ onuSerial: 'AB 12' }).success).toBe(false);
    expect(UpdateTaskSchema.safeParse({ onuSerial: 'HWTC123' }).success).toBe(false);
  });

  it('rechaza >24 caracteres', () => {
    expect(UpdateTaskSchema.safeParse({ onuSerial: 'A'.repeat(25) }).success).toBe(false);
    // 24 exactos SÍ pasa (límite inclusivo).
    expect(UpdateTaskSchema.safeParse({ onuSerial: 'A'.repeat(24) }).success).toBe(true);
  });

  it('rechaza caracteres no alfanuméricos (guiones, símbolos)', () => {
    expect(UpdateTaskSchema.safeParse({ onuSerial: 'HWTC-1111-22' }).success).toBe(false);
    expect(UpdateTaskSchema.safeParse({ onuSerial: 'HWTC:1111!22' }).success).toBe(false);
  });
});
