/**
 * Composition-root assertions for the UISP feature.
 * Guards:
 * 1. InMemoryUispSiteRepository implements UispSiteRepository port.
 * 2. InMemoryUispDeviceRepository implements UispDeviceRepository port.
 * 3. app.ts mounts createUispRouter at /api/uisp.
 * 4. app.ts wires UispSiteRepository and UispDeviceRepository.
 *
 * Mirrors inventory-composition-root.test.ts pattern (static source-text + behavioral).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { InMemoryUispSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispSiteRepository';
import { InMemoryUispDeviceRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispDeviceRepository';
import type { UispSiteRepository } from '../../../domain/ports/UispSiteRepository';
import type { UispDeviceRepository } from '../../../domain/ports/UispDeviceRepository';

describe('UISP composition root', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(
      join(__dirname, '..', '..', '..', 'infrastructure', 'http', 'app.ts'),
      'utf8',
    );
  });

  // Port parity: InMemoryUispSiteRepository satisfies UispSiteRepository
  it('InMemoryUispSiteRepository implements UispSiteRepository port', () => {
    const repo: UispSiteRepository = new InMemoryUispSiteRepository();
    expect(typeof repo.upsert).toBe('function');
    expect(typeof repo.listAll).toBe('function');
    expect(typeof repo.findByUispId).toBe('function');
    expect(typeof repo.markMissing).toBe('function');
    expect(typeof repo.clearMissing).toBe('function');
  });

  // Port parity: InMemoryUispDeviceRepository satisfies UispDeviceRepository
  it('InMemoryUispDeviceRepository implements UispDeviceRepository port', () => {
    const repo: UispDeviceRepository = new InMemoryUispDeviceRepository();
    expect(typeof repo.upsert).toBe('function');
    expect(typeof repo.listAll).toBe('function');
    expect(typeof repo.listBySiteId).toBe('function');
    expect(typeof repo.findByUispId).toBe('function');
    expect(typeof repo.markMissing).toBe('function');
    expect(typeof repo.clearMissing).toBe('function');
  });

  // app.ts mounts router at /api/uisp
  it('app.ts mounts createUispRouter at /api/uisp', () => {
    expect(appSrc).toContain("'/api/uisp'");
    expect(appSrc).toContain('createUispRouter');
  });

  // app.ts imports PrismaUispSiteRepository
  it('app.ts wires PrismaUispSiteRepository', () => {
    expect(appSrc).toContain('PrismaUispSiteRepository');
  });

  // app.ts imports PrismaUispDeviceRepository
  it('app.ts wires PrismaUispDeviceRepository', () => {
    expect(appSrc).toContain('PrismaUispDeviceRepository');
  });

  // FIX-1: new UpdateNetworkSite( MUST appear BEFORE createNetworkSiteRouter( in app.ts
  // Guards against the closure-with-undefined bug (let updateNetworkSite!: deferred pattern).
  it('new UpdateNetworkSite( appears before createNetworkSiteRouter( in app.ts', () => {
    const updateIdx = appSrc.indexOf('new UpdateNetworkSite(');
    const routerIdx = appSrc.indexOf('createNetworkSiteRouter(');
    expect(updateIdx).toBeGreaterThan(-1);
    expect(routerIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeLessThan(routerIdx);
  });

  // FIX-5: createAuthMiddleware must appear on the /api/network-sites mount line (auth guard)
  it('app.ts mounts /api/network-sites with createAuthMiddleware', () => {
    // Grab the line that mounts /api/network-sites
    const lines = appSrc.split('\n');
    const mountIdx = lines.findIndex(l => l.includes("'/api/network-sites'") || l.includes('"/api/network-sites"'));
    expect(mountIdx).toBeGreaterThan(-1);
    // The same app.use call should span a few lines and include createAuthMiddleware
    const mountBlock = lines.slice(mountIdx, mountIdx + 5).join('\n');
    expect(mountBlock).toContain('createAuthMiddleware');
  });

  // FIX-5e: requirePerm('uisp', 'read') and ('uisp', 'manage') must be present in the UISP router wiring
  it("app.ts wires requirePerm('uisp', 'read') for the UISP router", () => {
    expect(appSrc).toMatch(/requirePerm\(['"]uisp['"],\s*['"]read['"]\)/);
  });

  it("app.ts wires requirePerm('uisp', 'manage') for the UISP router", () => {
    expect(appSrc).toMatch(/requirePerm\(['"]uisp['"],\s*['"]manage['"]\)/);
  });
});
