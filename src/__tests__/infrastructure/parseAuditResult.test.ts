import { parseAuditResult } from '@infrastructure/adapters/audit/parseAuditResult';

describe('parseAuditResult', () => {
  it('parsea un array válido de findings (photoUrls default [])', () => {
    const r = parseAuditResult('[{"severity":"critical","category":"señal","text":"señal baja -28dBm"}]');
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ severity: 'critical', category: 'señal', text: 'señal baja -28dBm', photoUrls: [] });
  });

  it('array vacío → ok con findings vacío', () => {
    expect(parseAuditResult('[]')).toEqual({ ok: true, findings: [] });
  });

  it('descarta items con severity/category fuera del enum o text vacío', () => {
    const r = parseAuditResult('[{"severity":"alto","category":"señal","text":"x"},{"severity":"warning","category":"fotos","text":""},{"severity":"ok","category":"otros","text":"bien"}]');
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].text).toBe('bien');
  });

  it('JSON envuelto en fences se parsea', () => {
    const r = parseAuditResult('```json\n[{"severity":"ok","category":"otros","text":"sin observaciones"}]\n```');
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(1);
  });

  it('prosa / no-JSON → ok:false', () => {
    expect(parseAuditResult('no pude analizar la instalación')).toEqual({ ok: false, findings: [] });
  });

  it('JSON que no es array (objeto) → ok:false', () => {
    expect(parseAuditResult('{"severity":"ok"}')).toEqual({ ok: false, findings: [] });
  });

  it('preserva photoUrls cuando vienen', () => {
    const r = parseAuditResult('[{"severity":"warning","category":"fotos","text":"foto borrosa","photoUrls":["https://x/a.jpg"]}]');
    expect(r.findings[0].photoUrls).toEqual(['https://x/a.jpg']);
  });
});
