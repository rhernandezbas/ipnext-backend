/**
 * FIX 3 — Static composition guard: the three production bootstraps that run the
 * IClass closure cron MUST inject PrismaIClassStatusCatalogRepository into both
 * IngestClosedServiceOrders AND PrismaSchedulingRepository. Without it the
 * iclass-status-sync feature is dead in prod (catalog never auto-populated,
 * iclassStatusCode never written on cron ticks).
 *
 * This test reads the bootstrap source files as text and asserts that:
 *   - PrismaIClassStatusCatalogRepository is imported.
 *   - An instance is created (new PrismaIClassStatusCatalogRepository()).
 *   - It is passed to new PrismaSchedulingRepository(...).
 *   - It is passed to new IngestClosedServiceOrders(...) (via options object or positional arg).
 *
 * Uses the static source-text guard pattern from task-general-status-composition.test.ts
 * and uisp-composition.test.ts. Would FAIL if the wiring from FIX 1 were reverted.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SCHEDULING_DIR = join(__dirname, '..', '..', 'infrastructure', 'scheduling');

describe('Bootstrap iclass-status catalog wiring (FIX 1 guard)', () => {
  let closureSrc: string;
  let backfillSrc: string;
  let autocompleteSrc: string;

  beforeAll(() => {
    closureSrc = readFileSync(join(SCHEDULING_DIR, 'bootstrapIClassClosure.ts'), 'utf8');
    backfillSrc = readFileSync(join(SCHEDULING_DIR, 'bootstrapBackfill.ts'), 'utf8');
    autocompleteSrc = readFileSync(join(SCHEDULING_DIR, 'bootstrapTaskAutocomplete.ts'), 'utf8');
  });

  // ── bootstrapIClassClosure ────────────────────────────────────────────────

  it('bootstrapIClassClosure imports PrismaIClassStatusCatalogRepository', () => {
    expect(closureSrc).toContain('PrismaIClassStatusCatalogRepository');
  });

  it('bootstrapIClassClosure instantiates PrismaIClassStatusCatalogRepository', () => {
    expect(closureSrc).toContain('new PrismaIClassStatusCatalogRepository()');
  });

  it('bootstrapIClassClosure passes statusCatalog to PrismaSchedulingRepository', () => {
    // new PrismaSchedulingRepository(catalogRepo) or similar — the catalog must appear
    // as argument to PrismaSchedulingRepository so setIClassStatus can resolve labels.
    const match = closureSrc.match(/new PrismaSchedulingRepository\(([\s\S]*?)\)/);
    expect(match).not.toBeNull();
    // The captured argument must reference the catalog variable
    const args = match![1];
    expect(args).toMatch(/[Cc]atalog/);
  });

  it('bootstrapIClassClosure passes statusCatalog to IngestClosedServiceOrders', () => {
    // statusCatalog must appear inside the IngestClosedServiceOrders(...) call
    const match = closureSrc.match(/new IngestClosedServiceOrders\(([\s\S]*?)\)\s*;/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toMatch(/[Cc]atalog/);
  });

  // ── bootstrapBackfill ─────────────────────────────────────────────────────

  it('bootstrapBackfill imports PrismaIClassStatusCatalogRepository', () => {
    expect(backfillSrc).toContain('PrismaIClassStatusCatalogRepository');
  });

  it('bootstrapBackfill instantiates PrismaIClassStatusCatalogRepository', () => {
    expect(backfillSrc).toContain('new PrismaIClassStatusCatalogRepository()');
  });

  it('bootstrapBackfill passes statusCatalog to PrismaSchedulingRepository', () => {
    const match = backfillSrc.match(/new PrismaSchedulingRepository\(([\s\S]*?)\)/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toMatch(/[Cc]atalog/);
  });

  it('bootstrapBackfill passes statusCatalog to IngestClosedServiceOrders', () => {
    const match = backfillSrc.match(/new IngestClosedServiceOrders\(([\s\S]*?)\)\s*;/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toMatch(/[Cc]atalog/);
  });

  // ── bootstrapTaskAutocomplete ─────────────────────────────────────────────

  it('bootstrapTaskAutocomplete imports PrismaIClassStatusCatalogRepository', () => {
    expect(autocompleteSrc).toContain('PrismaIClassStatusCatalogRepository');
  });

  it('bootstrapTaskAutocomplete instantiates PrismaIClassStatusCatalogRepository', () => {
    expect(autocompleteSrc).toContain('new PrismaIClassStatusCatalogRepository()');
  });

  it('bootstrapTaskAutocomplete passes statusCatalog to PrismaSchedulingRepository', () => {
    const match = autocompleteSrc.match(/new PrismaSchedulingRepository\(([\s\S]*?)\)/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toMatch(/[Cc]atalog/);
  });

  it('bootstrapTaskAutocomplete passes statusCatalog to IngestClosedServiceOrders', () => {
    const match = autocompleteSrc.match(/new IngestClosedServiceOrders\(([\s\S]*?)\)\s*;/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toMatch(/[Cc]atalog/);
  });
});
