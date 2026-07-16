/**
 * Composition-root assertions for the UISP feature.
 * Guards:
 * 1. InMemoryUispSiteRepository implements UispSiteRepository port.
 * 2. InMemoryUispDeviceRepository implements UispDeviceRepository port.
 * 3. app.ts mounts createUispRouter at /api/uisp.
 * 4. app.ts wires UispSiteRepository and UispDeviceRepository.
 * 5. bootstrapUispSync.ts passes PrismaNetworkSiteRepository (5th arg) to SyncUispMirror.
 * 6. app.ts passes listNetworkSitesWithUisp to createNetworkSiteRouter.
 *
 * Mirrors inventory-composition-root.test.ts pattern (static source-text + behavioral).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { InMemoryUispSiteRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispSiteRepository';
import { InMemoryUispDeviceRepository } from '../../../infrastructure/adapters/in-memory/InMemoryUispDeviceRepository';
import { InMemoryAccessPointRepository } from '../../../infrastructure/adapters/in-memory/InMemoryAccessPointRepository';
import type { UispSiteRepository } from '../../../domain/ports/UispSiteRepository';
import type { UispDeviceRepository } from '../../../domain/ports/UispDeviceRepository';
import type { AccessPointRepository } from '../../../domain/ports/AccessPointRepository';

describe('UISP composition root', () => {
  let appSrc: string;
  let bootstrapSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(
      join(__dirname, '..', '..', '..', 'infrastructure', 'http', 'app.ts'),
      'utf8',
    );
    bootstrapSrc = readFileSync(
      join(__dirname, '..', '..', '..', 'infrastructure', 'scheduling', 'bootstrapUispSync.ts'),
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

  // Port parity: InMemoryAccessPointRepository satisfies AccessPointRepository (Bulk WhatsApp F2/F3)
  it('InMemoryAccessPointRepository implements AccessPointRepository port', () => {
    const repo: AccessPointRepository = new InMemoryAccessPointRepository();
    expect(typeof repo.upsertByUispDeviceId).toBe('function');
    expect(typeof repo.findMany).toBe('function');
    expect(typeof repo.findByNetworkSiteId).toBe('function');
    expect(typeof repo.findById).toBe('function');
  });

  // contract-node-ap-catalog: bootstrapUispSync.ts passes PrismaAccessPointRepository as 6th arg
  // to SyncUispMirror. If this arg is ever silently dropped, the AP catalog stops seeding in
  // production while in-memory tests stay green (same reasoning as the networkSiteRepo guard).
  it('bootstrapUispSync.ts passes PrismaAccessPointRepository to SyncUispMirror constructor', () => {
    expect(bootstrapSrc).toContain('PrismaAccessPointRepository');
    expect(bootstrapSrc).toMatch(/new SyncUispMirror\([^)]*accessPointRepo[^)]*\)/s);
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

  // FIX-2a: bootstrapUispSync.ts passes PrismaNetworkSiteRepository as 5th arg to SyncUispMirror.
  // If this arg is ever silently removed, the autoimport stops running in production
  // while tests stay green (InMemory always persists uispSiteId, Prisma doesn't).
  it('bootstrapUispSync.ts passes PrismaNetworkSiteRepository to SyncUispMirror constructor', () => {
    // Must import PrismaNetworkSiteRepository
    expect(bootstrapSrc).toContain('PrismaNetworkSiteRepository');
    // Must pass networkSiteRepo variable to SyncUispMirror (5th positional arg)
    expect(bootstrapSrc).toContain('new SyncUispMirror(');
    // The networkSiteRepo local variable must be referenced in the SyncUispMirror call
    expect(bootstrapSrc).toMatch(/new SyncUispMirror\([^)]*networkSiteRepo[^)]*\)/s);
  });

  // FIX-2b: app.ts passes listNetworkSitesWithUisp to createNetworkSiteRouter.
  // If the 6th optional arg is ever dropped, the GET /api/network-sites falls back
  // to the non-enriched ListNetworkSites (no uisp column data) — silently broken.
  it('app.ts passes listNetworkSitesWithUisp to createNetworkSiteRouter', () => {
    // Must have the use case wired
    expect(appSrc).toContain('listNetworkSitesWithUisp');
    expect(appSrc).toContain('ListNetworkSitesWithUisp');
    // The createNetworkSiteRouter call must include listNetworkSitesWithUisp as an arg
    expect(appSrc).toMatch(/createNetworkSiteRouter\([^)]*listNetworkSitesWithUisp[^)]*\)/s);
  });

  // contract-node-ap-auto-assign (AA-5) — bootstrapUispSync.ts builds AutoAssignContractNetwork
  // with the Prisma adapters (pppoe, RadiusEvent, Contract; reuses UispDevice/AccessPoint/SyncState).
  it('bootstrapUispSync.ts constructs AutoAssignContractNetwork with the Prisma adapters', () => {
    expect(bootstrapSrc).toContain('AutoAssignContractNetwork');
    expect(bootstrapSrc).toContain('PrismaPppoeServiceRepository');
    expect(bootstrapSrc).toContain('PrismaRadiusEventRepository');
    expect(bootstrapSrc).toContain('PrismaContractRepository');
    expect(bootstrapSrc).toMatch(/new AutoAssignContractNetwork\(/);
  });

  // Guard "tests verdes pero prod no asigna" (mismo patrón que el 6to arg de Fase A): si el
  // autoAssign se cae en silencio del ctor de UispSyncScheduler, el scheduler nunca lo invoca
  // en producción aunque todos los tests del use case sigan en verde.
  it('bootstrapUispSync.ts passes autoAssign as the 6th arg to UispSyncScheduler', () => {
    expect(bootstrapSrc).toMatch(/new UispSyncScheduler\([^)]*autoAssign[^)]*\)/s);
  });
});
