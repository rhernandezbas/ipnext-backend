/**
 * pppoe-composition.test.ts — assertion estática sobre app.ts.
 *
 * Propósito: pinear el wiring PPPoE en createApp() para que cualquier
 * reorganización de app.ts que saque el router o rompa la DI sea detectada
 * inmediatamente (sin levantar la DB real). Anti-"feature muerta".
 *
 * Assertions:
 *   (a) createPppoeRouter está importado en app.ts
 *   (b) createPppoeRouter es llamado con requirePerm (RBAC wiring presente)
 *   (c) el router se monta en '/api' (para que /api/contracts y /api/pppoe funcionen)
 *   (d) PrismaPppoeServiceRepository está instanciado en el bloque PPPoE
 *   (e) ListPppoeByContract, CreatePppoeService, UpdatePppoeService,
 *       MovePppoeServiceToRouter, DeactivatePppoeService están wired
 *   (f) RouterOsGateway está instanciado en el bloque PPPoE
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('PPPoE composition root (#pppoe-service Fase B)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
  });

  it('(a) createPppoeRouter está importado', () => {
    expect(appSrc).toMatch(/import.*createPppoeRouter.*from.*pppoe\.routes/);
  });

  it('(b) createPppoeRouter es llamado con requirePerm (RBAC guard presente)', () => {
    const idx = appSrc.indexOf('createPppoeRouter(');
    expect(idx).toBeGreaterThan(-1);
    const window = appSrc.slice(idx, idx + 600);
    expect(window).toMatch(/requirePerm/);
  });

  it("(c) router PPPoE montado en '/api'", () => {
    expect(appSrc).toMatch(/app\.use\(\s*['"]\/api['"]\s*,\s*createPppoeRouter/);
  });

  it('(d) PrismaPppoeServiceRepository está instanciado', () => {
    expect(appSrc).toMatch(/new PrismaPppoeServiceRepository\(\)/);
  });

  it('(e) RouterOsGateway está instanciado', () => {
    expect(appSrc).toMatch(/new RouterOsGateway\(\)/);
  });

  it('(e) ListPppoeByContract está wired', () => {
    expect(appSrc).toMatch(/new ListPppoeByContract\(/);
  });

  it('(e) CreatePppoeService está wired', () => {
    expect(appSrc).toMatch(/new CreatePppoeService\(/);
  });

  it('(e) UpdatePppoeService está wired', () => {
    expect(appSrc).toMatch(/new UpdatePppoeService\(/);
  });

  it('(e) MovePppoeServiceToRouter está wired', () => {
    expect(appSrc).toMatch(/new MovePppoeServiceToRouter\(/);
  });

  it('(e) DeactivatePppoeService está wired', () => {
    expect(appSrc).toMatch(/new DeactivatePppoeService\(/);
  });
});
