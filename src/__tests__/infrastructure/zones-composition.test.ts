/**
 * zones-composition.test.ts — static assertion sobre app.ts.
 *
 * Verifica que el wiring de Zones en createApp() está presente y correcto.
 * No levanta la DB real — solo parsea el texto del archivo.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Zones composition root (customer-zones-map)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
  });

  it('(a) createZonesRouter está importado', () => {
    expect(appSrc).toMatch(/import.*createZonesRouter.*from.*zones\.routes/);
  });

  it('(b) PrismaZoneRepository está importado', () => {
    expect(appSrc).toMatch(/import.*PrismaZoneRepository.*from.*PrismaZoneRepository/);
  });

  it("(c) router de zones montado en '/api'", () => {
    expect(appSrc).toMatch(/app\.use\(\s*['"]\/api['"]\s*,\s*createZonesRouter/);
  });

  it('(d) PrismaZoneRepository está instanciado', () => {
    expect(appSrc).toMatch(/new PrismaZoneRepository\(\)/);
  });

  it('(e) requirePerm está pasado al router (RBAC guard presente)', () => {
    const idx = appSrc.indexOf('createZonesRouter(');
    expect(idx).toBeGreaterThan(-1);
    const window = appSrc.slice(idx, idx + 400);
    expect(window).toMatch(/requirePerm/);
  });

  it('(e) ListZones está wired', () => {
    expect(appSrc).toMatch(/new ListZones\(/);
  });

  it('(e) CreateZone está wired', () => {
    expect(appSrc).toMatch(/new CreateZone\(/);
  });

  it('(e) GetZone está wired', () => {
    expect(appSrc).toMatch(/new GetZone\(/);
  });

  it('(e) UpdateZone está wired', () => {
    expect(appSrc).toMatch(/new UpdateZone\(/);
  });

  it('(e) DeleteZone está wired', () => {
    expect(appSrc).toMatch(/new DeleteZone\(/);
  });
});
