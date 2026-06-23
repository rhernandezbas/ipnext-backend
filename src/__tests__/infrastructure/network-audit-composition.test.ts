/**
 * network-audit-composition.test.ts — assert estático sobre app.ts (wiring pin).
 *
 * FIX4: verifica que createRadiusRouter se llama con listRadiusEvents Y listNe8000Audit
 * (antes eran opcionales; si faltaban la ruta no se registraba → 404 silencioso).
 *
 * Clona el patrón de pppoe-composition.test.ts:
 *   - Lee app.ts como string (sin levantar la DB).
 *   - Aserta presencia de imports/instancias/llamadas.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Network Audit composition root (FIX4 wiring pin)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
  });

  it('(a) createRadiusRouter está importado en app.ts', () => {
    expect(appSrc).toMatch(/import.*createRadiusRouter.*from.*radius\.routes/);
  });

  it('(b) PrismaRadiusEventRepository está instanciado', () => {
    expect(appSrc).toMatch(/new PrismaRadiusEventRepository\(\)/);
  });

  it('(c) ListRadiusEvents está wired (new ListRadiusEvents(', () => {
    expect(appSrc).toMatch(/new ListRadiusEvents\(/);
  });

  it('(d) ListNe8000PppoeAudit está wired (new ListNe8000PppoeAudit(', () => {
    expect(appSrc).toMatch(/new ListNe8000PppoeAudit\(/);
  });

  it('(e) createRadiusRouter se llama con listRadiusEvents como argumento', () => {
    const idx = appSrc.indexOf('createRadiusRouter(');
    expect(idx).toBeGreaterThan(-1);
    const window = appSrc.slice(idx, idx + 500);
    expect(window).toMatch(/listRadiusEvents/);
  });

  it('(f) createRadiusRouter se llama con listNe8000Audit como argumento', () => {
    const idx = appSrc.indexOf('createRadiusRouter(');
    expect(idx).toBeGreaterThan(-1);
    const window = appSrc.slice(idx, idx + 500);
    expect(window).toMatch(/listNe8000Audit/);
  });
});
