/**
 * #43 — composition-root static guard.
 * Booting createApp() needs a live DB, so this asserts the wiring statically by reading
 * app.ts source (pattern: task-general-status-composition.test.ts):
 *  (a) createServiceCatalogRouter is wired with requirePerm
 *  (b) createContractServicesRouter is wired with requirePerm
 *  (c) UpdateContractName is constructed with the contractRepo
 *  (d) both routers are mounted at the '/api' root
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Contract services composition root (#43)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
  });

  it('(a) createServiceCatalogRouter is wired with requirePerm', () => {
    const idx = appSrc.indexOf('createServiceCatalogRouter(');
    expect(idx).toBeGreaterThan(-1);
    const window = appSrc.slice(idx, idx + 800);
    expect(window).toMatch(/requirePerm/);
  });

  it('(b) createContractServicesRouter is wired with requirePerm', () => {
    const idx = appSrc.indexOf('createContractServicesRouter(');
    expect(idx).toBeGreaterThan(-1);
    const window = appSrc.slice(idx, idx + 800);
    expect(window).toMatch(/requirePerm/);
  });

  it('(c) new UpdateContractName(...) is constructed with contractRepo', () => {
    expect(appSrc).toMatch(/new UpdateContractName\([^)]*contractRepo/);
  });

  it("(d) both routers are mounted at the '/api' root", () => {
    expect(appSrc).toMatch(/app\.use\(\s*['"]\/api['"]\s*,\s*createServiceCatalogRouter/);
    expect(appSrc).toMatch(/app\.use\(\s*['"]\/api['"]\s*,\s*createContractServicesRouter/);
  });
});
