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
    // #65 fix wave — the deps block grew (getTvCredentials); widen the window so the first
    // requirePerm('tv', …) is still inside it.
    // service-transfer — grew again (transferTv + its comment); widened once more.
    // gigared-tv-identity-hardening (D4/D7/B7) — grew again (listAccounts + transferTv gained
    // deps, plus their comments); widened once more.
    const window = appSrc.slice(idx, idx + 2900);
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
    // #47k: ownership-aware contract lookup, not the existence-only one.
    expect(m![1]).toMatch(/gigaredContractLookup/);
  });

  it('(f) #47k new CancelTv is wired with gigared client + contract-services + catalog repos', () => {
    const m = appSrc.match(/new CancelTv\(([^)]*)\)/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/gigaredClient/);
    expect(m![1]).toMatch(/contractServiceRepo/);
    expect(m![1]).toMatch(/serviceCatalogRepo/);
    expect(m![1]).toMatch(/gigaredContractLookup/);
  });

  it('(h) service-transfer: TransferTvToCustomer is wired with the shared deps + event repo + tv.transfer guard', () => {
    const m = appSrc.match(/new TransferTvToCustomer\(([^)]*)\)/);
    expect(m).not.toBeNull();
    // Mismas deps compartidas del bloque gigared (cliente, lookups ownership-aware, repos locales,
    // flag de baja local) + el singleton del historial de eventos (contractServiceEventRepo).
    expect(m![1]).toMatch(/gigaredClient/);
    expect(m![1]).toMatch(/gigaredCustomerLookup/);
    expect(m![1]).toMatch(/gigaredContractLookup/);
    expect(m![1]).toMatch(/contractServiceRepo/);
    expect(m![1]).toMatch(/serviceCatalogRepo/);
    expect(m![1]).toMatch(/gigaredTvCancellation/);
    expect(m![1]).toMatch(/contractServiceEventRepo/);
    // gigared-tv-identity-hardening (D7/B7) — el historial TV global (evento 'transferencia')
    // necesita el MISMO singleton que Register/Cancel ya usan.
    expect(m![1]).toMatch(/gigaredTvActivationEventRepo/);
    // Guard granular nuevo: tv.transfer (doble capa BE+FE).
    expect(appSrc).toMatch(/requireTransfer:\s*requirePerm\(\s*['"]tv['"],\s*['"]transfer['"]\s*\)/);
  });

  it('(i) gigared-tv-identity-hardening (D4/B7): ListGigaredAccounts is wired with the contract-services + catalog repos (local-first)', () => {
    const m = appSrc.match(/new ListGigaredAccounts\(([^)]*)\)/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/contractServiceRepo/);
    expect(m![1]).toMatch(/serviceCatalogRepo/);
  });

  it('(g) #47k/#115: the Gigared TV use cases use an ownership-aware contract lookup (clientId + grContratoId)', () => {
    // The dedicated lookup must select clientId so the use cases can assert ownership,
    // and grContratoId so RegisterGigaredAccount can derive the deterministic TV identity (#115).
    expect(appSrc).toMatch(/prismaContractOwnershipLookup/);
    // #115 — grContratoId is now also selected (alongside id and clientId).
    expect(appSrc).toMatch(/select:\s*\{\s*id:\s*true,\s*clientId:\s*true,\s*grContratoId:\s*true\s*\}/);
    // Add/Remove TV are wired with the ownership lookup too — not the existence-only one.
    const add = appSrc.match(/new AddTvService\(([^)]*)\)/);
    expect(add![1]).toMatch(/gigaredContractLookup/);
    const rem = appSrc.match(/new RemoveTvService\(([^)]*)\)/);
    expect(rem![1]).toMatch(/gigaredContractLookup/);
  });
});
