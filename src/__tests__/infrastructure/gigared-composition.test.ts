/**
 * #47 — composition-root static guard (pattern: contract-services-composition.test.ts).
 * Booting createApp() needs a live DB; assert the wiring statically by reading app.ts source:
 *  (a) createGigaredRouter is wired with requirePerm('tv', …)
 *  (b) the router is mounted at '/api/gigared'
 *  (c) new GigaredClient is constructed with the gigared config repo
 *  (d) new AddTvService is constructed with the contract-services repo
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Gigared composition root (#47)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
  });

  it("(a) createGigaredRouter is wired with requirePerm('tv', …)", () => {
    const idx = appSrc.indexOf('createGigaredRouter(');
    expect(idx).toBeGreaterThan(-1);
    const window = appSrc.slice(idx, idx + 1200);
    expect(window).toMatch(/requirePerm\(\s*['"]tv['"]/);
  });

  it("(b) the router is mounted at '/api/gigared'", () => {
    expect(appSrc).toMatch(/app\.use\(\s*['"]\/api\/gigared['"]/);
  });

  it('(c) new GigaredClient is constructed with the gigared config repo', () => {
    expect(appSrc).toMatch(/new GigaredClient\([\s\S]*?gigaredConfigRepo/);
  });

  it('(d) new AddTvService is constructed with the contract-services repo', () => {
    expect(appSrc).toMatch(/new AddTvService\(/);
  });

  it('(e) new LinkCustomerToCic is wired with the contract-services + catalog repos (47f reconcile)', () => {
    const m = appSrc.match(/new LinkCustomerToCic\(([^)]*)\)/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/contractServiceRepo/);
    expect(m![1]).toMatch(/serviceCatalogRepo/);
    expect(m![1]).toMatch(/contractLookup/);
  });
});
