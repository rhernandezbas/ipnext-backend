/**
 * smartolt-provision (K2) — funciones PURAS del aprovisionamiento de ONUs fibra:
 *  - isHuaweiSn: solo Huawei (prefijo HWTC) se auto-aprovisiona.
 *  - deriveWifiSsids: `IPNEXT_<APELLIDO>_2.4` / `IPNEXT_<APELLIDO>_5` (apellido =
 *    PRIMER token del Client.name GR "APELLIDO(S) NOMBRE(S)", mayúsculas sin acentos).
 *  - deriveWifiPassword: número de contrato + dígitos random hasta 8 (RNG inyectable).
 *  - deriveSpeedProfileNames: mapping best-effort plan GR → nombre de speed profile
 *    SmartOLT ("300MB"→"300M", "50/25MB"→down 50M/up 25M). No parseable → null.
 */
import {
  isHuaweiSn,
  deriveWifiSsids,
  deriveWifiPassword,
  deriveSpeedProfileNames,
} from '@domain/services/fiberProvisioning';

describe('isHuaweiSn', () => {
  it('SN con prefijo HWTC → true', () => {
    expect(isHuaweiSn('HWTC12AB34CD')).toBe(true);
  });

  it('prefijo en minúsculas → true (case-insensitive)', () => {
    expect(isHuaweiSn('hwtc99ff00aa')).toBe(true);
  });

  it('SN de otro vendor (ZTEG) → false', () => {
    expect(isHuaweiSn('ZTEGC1234567')).toBe(false);
  });

  it('string vacío → false', () => {
    expect(isHuaweiSn('')).toBe(false);
  });
});

describe('deriveWifiSsids', () => {
  it('apellido = PRIMER token del nombre GR, en mayúsculas', () => {
    expect(deriveWifiSsids('HERNANDEZ RONALD')).toEqual({
      ssid24: 'IPNEXT_HERNANDEZ_2.4',
      ssid5: 'IPNEXT_HERNANDEZ_5',
    });
  });

  it('acentos y ñ se normalizan (GARCÍA→GARCIA, MUÑOZ→MUNOZ)', () => {
    expect(deriveWifiSsids('GARCÍA MARÍA').ssid24).toBe('IPNEXT_GARCIA_2.4');
    expect(deriveWifiSsids('muñoz pedro').ssid5).toBe('IPNEXT_MUNOZ_5');
  });

  it('nombre de UN solo token (razón social) usa ese token', () => {
    expect(deriveWifiSsids('COOPERATIVA')).toEqual({
      ssid24: 'IPNEXT_COOPERATIVA_2.4',
      ssid5: 'IPNEXT_COOPERATIVA_5',
    });
  });

  it('FIX LOW-c: apellido vacío (nombre vacío o solo símbolos) → fallback IPNEXT_CLIENTE_*', () => {
    expect(deriveWifiSsids('')).toEqual({
      ssid24: 'IPNEXT_CLIENTE_2.4',
      ssid5: 'IPNEXT_CLIENTE_5',
    });
    expect(deriveWifiSsids('*** ---')).toEqual({
      ssid24: 'IPNEXT_CLIENTE_2.4',
      ssid5: 'IPNEXT_CLIENTE_5',
    });
  });

  it('FIX LOW-c: apellido largo se trunca para que NINGÚN ssid supere 32 bytes', () => {
    // 26 chars — 'IPNEXT_' (7) + 26 + '_2.4' (4) = 37 > 32 sin truncar.
    const ssids = deriveWifiSsids('ABCDEFGHIJKLMNOPQRSTUVWXYZ PEDRO');
    expect(ssids.ssid24.length).toBeLessThanOrEqual(32);
    expect(ssids.ssid5.length).toBeLessThanOrEqual(32);
    // Mismo apellido truncado en AMBAS bandas (max 21 = 32 - 7 - 4).
    expect(ssids.ssid24).toBe('IPNEXT_ABCDEFGHIJKLMNOPQRSTU_2.4');
    expect(ssids.ssid5).toBe('IPNEXT_ABCDEFGHIJKLMNOPQRSTU_5');
  });
});

describe('deriveWifiPassword', () => {
  it('contrato corto → contrato + dígitos random hasta completar 8', () => {
    // rng fijo en 0.7 → dígito 7 en cada draw.
    const password = deriveWifiPassword('45123', () => 0.7);
    expect(password).toBe('45123777');
    expect(password).toHaveLength(8);
  });

  it('contrato de 8+ caracteres → queda tal cual (ya cumple el mínimo WPA2)', () => {
    expect(deriveWifiPassword('123456789', () => 0.1)).toBe('123456789');
  });

  it('contrato vacío/null → 8 dígitos random', () => {
    const password = deriveWifiPassword(null, () => 0.3);
    expect(password).toBe('33333333');
  });

  it('dígitos distintos según el RNG (no hardcodeado)', () => {
    let i = 0;
    const seq = [0.1, 0.2, 0.9];
    const password = deriveWifiPassword('45123', () => seq[i++ % seq.length]!);
    expect(password).toBe('45123129');
  });
});

describe('deriveSpeedProfileNames', () => {
  it('"300MB" → 300M simétrico', () => {
    expect(deriveSpeedProfileNames('300MB')).toEqual({ download: '300M', upload: '300M' });
  });

  it('"50/25MB" → download 50M, upload 25M', () => {
    expect(deriveSpeedProfileNames('50/25MB')).toEqual({ download: '50M', upload: '25M' });
  });

  it('plan con texto alrededor ("PLAN FIBRA 100MB") → 100M', () => {
    expect(deriveSpeedProfileNames('PLAN FIBRA 100MB')).toEqual({
      download: '100M',
      upload: '100M',
    });
  });

  it('plan sin números → null (best-effort: authorize sin speed profiles)', () => {
    expect(deriveSpeedProfileNames('CORPORATIVO')).toBeNull();
    expect(deriveSpeedProfileNames('FIBRA')).toBeNull();
    expect(deriveSpeedProfileNames('')).toBeNull();
  });

  it('FIX H1: "1G" → null (unidad no soportada — 1M silencioso sería un cliente gigabit a 1 mega)', () => {
    expect(deriveSpeedProfileNames('1G')).toBeNull();
  });

  it('FIX H1: números SIN unidad de velocidad se ignoran ("PROMO 2X1 300MB" → 300M, no 2M)', () => {
    expect(deriveSpeedProfileNames('PROMO 2X1 300MB')).toEqual({
      download: '300M',
      upload: '300M',
    });
  });

  it('FIX H1: un año en el nombre no es una velocidad ("PLAN 2025 300MB" → 300M, no 2025M)', () => {
    expect(deriveSpeedProfileNames('PLAN 2025 300MB')).toEqual({
      download: '300M',
      upload: '300M',
    });
  });

  it('FIX H1: sufijo "M" pelado también cuenta ("300M" → 300M)', () => {
    expect(deriveSpeedProfileNames('300M')).toEqual({ download: '300M', upload: '300M' });
  });

  it('FIX H1: DOS velocidades distintas con unidad → AMBIGUO → null (mejor sin profile que errado)', () => {
    expect(deriveSpeedProfileNames('300MB O 100MB')).toBeNull();
  });
});
