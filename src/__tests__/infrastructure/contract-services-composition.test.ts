/**
 * #43 / #110 — composition-root static guard.
 * Booting createApp() needs a live DB, so this asserts the wiring statically by reading
 * app.ts source (pattern: task-general-status-composition.test.ts):
 *  (a) createServiceCatalogRouter is wired with requirePerm
 *  (b) createContractServicesRouter is wired with requirePerm
 *  (c) UpdateContractName is constructed with the contractRepo
 *  (d) both routers are mounted at the '/api' root
 *  (e) #110: ListContractServiceHistory is constructed with 3 ports (csRepo + cseRepo + tvEventRepo)
 *  (f) #110: contractServiceEventRepo is injected in AddContractService, UpdateContractService,
 *            and RemoveContractService
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

  // #110 wiring guards — verify the 3-port ListContractServiceHistory and cseRepo injections.
  it('(e) #110: ListContractServiceHistory is constructed with csRepo + cseRepo + tvEventRepo', () => {
    // Must match: new ListContractServiceHistory(contractServiceRepo, contractServiceEventRepo, contractServicesTvEventRepo)
    expect(appSrc).toMatch(
      /new ListContractServiceHistory\(\s*contractServiceRepo\s*,\s*contractServiceEventRepo\s*,\s*contractServicesTvEventRepo\s*\)/,
    );
  });

  it('(f) #110: contractServiceEventRepo is injected in AddContractService', () => {
    expect(appSrc).toMatch(/new AddContractService\([^)]*contractServiceEventRepo/);
  });

  it('(f) #110: contractServiceEventRepo is injected in UpdateContractService', () => {
    expect(appSrc).toMatch(/new UpdateContractService\([^)]*contractServiceEventRepo/);
  });

  it('(f) #110: contractServiceEventRepo is injected in RemoveContractService', () => {
    expect(appSrc).toMatch(/new RemoveContractService\([^)]*contractServiceEventRepo/);
  });
});
