import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * finance-growth Fase 1 (task 1.58) — composition-root guard, molde
 * `inventory-composition-root.test.ts`. Pins that `app.ts`/`main.ts` actually
 * wire `FinanceReceiptIngestScheduler` with its REAL Prisma-backed
 * collaborators (not a fixture quietly filtering into prod) — the exact
 * failure mode that killed a Wave 6 feature silently (the hook was never
 * injected while tests wired their own fixture and stayed green).
 */
describe('finance-growth composition root — Fase 1 receipt-ingest wiring', () => {
  let appSrc: string;
  let mainSrc: string;
  let bootstrapSrc: string;
  let snapshotBootstrapSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
    mainSrc = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');
    bootstrapSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'scheduling', 'bootstrapFinanceReceiptsIngest.ts'), 'utf8');
    snapshotBootstrapSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'scheduling', 'bootstrapFinanceSnapshotJob.ts'),
      'utf8',
    );
  });

  it('app.ts imports FinanceReceiptIngestScheduler and createFinanceGrowthRouter', () => {
    expect(appSrc).toContain("from '../scheduling/FinanceReceiptIngestScheduler'");
    expect(appSrc).toContain("from './routes/financeGrowth.routes'");
  });

  it('createApp accepts a financeReceiptIngestScheduler parameter typed as FinanceReceiptIngestScheduler', () => {
    const match = appSrc.match(/export function createApp\(([\s\S]*?)\)\s*\{/);
    expect(match).not.toBeNull();
    const params = match![1];
    expect(params).toContain('financeReceiptIngestScheduler');
    expect(params).toMatch(/financeReceiptIngestScheduler\?\s*:\s*FinanceReceiptIngestScheduler/);
  });

  it('mounts createFinanceGrowthRouter at /api/finance/growth', () => {
    expect(appSrc).toContain("'/api/finance/growth'");
    expect(appSrc).toContain('createFinanceGrowthRouter(');
  });

  it('wires REAL Prisma repos into the invoice-type use cases (not a fixture)', () => {
    const callIdx = appSrc.indexOf('createFinanceGrowthRouter(');
    expect(callIdx).toBeGreaterThan(-1);
    const callWindow = appSrc.slice(callIdx, callIdx + 1000);
    expect(callWindow).toContain('new ListFinanceInvoiceTypes(financeInvoiceTypesRepo)');
    expect(callWindow).toContain('new ReclassifyFinanceInvoiceType(financeInvoiceTypesRepo)');
    expect(callWindow).toContain('new GetFinanceSyncStatus(financeSyncStateRepo)');
    // fix-wave-1 F8 — ForceFinanceDeltaRun now also takes the shared DistributedLock.
    expect(callWindow).toContain('new ForceFinanceDeltaRun(financeSyncStateRepo, financeForceRunLock)');
    expect(appSrc).toContain('new PrismaFinanceInvoiceTypeClassificationRepository()');
  });

  // fix-wave-2 — these two assertions used to slice a FIXED 1000-char window from
  // the `createFinanceGrowthRouter(` call site, which made them silently blind:
  // R6 inserted a 339-char explanatory comment INSIDE the call, pushing
  // `isSchedulerRunning` to offset 951 (so its ~75-char pattern got cut off at the
  // 1000 boundary) and `getPacingStatus` to 1034 (fully outside). Both wirings were
  // CORRECT in app.ts and the tests failed anyway — a fix breaking a sibling fix's
  // test without any production bug. The window now ends at the router's closing
  // `}));` instead of a magic number, so comments can never blind it again.
  const financeRouterCall = (): string => {
    const start = appSrc.indexOf('createFinanceGrowthRouter(');
    expect(start).toBeGreaterThan(-1);
    const end = appSrc.indexOf('}));', start);
    expect(end).toBeGreaterThan(start);
    return appSrc.slice(start, end);
  };

  it('fix-wave-2 R3: isSchedulerRunning reflects the LIVE isEnabled() signal, not mere existence (503 guard for POST /sync/run)', () => {
    const callWindow = financeRouterCall();
    // fix-wave-1's `!= null` check went stale the moment F6 removed the
    // boot-time `enabled` gate: the object exists whenever GR is on,
    // regardless of the DB kill-switch. Must consult `isEnabled()`.
    expect(callWindow).toMatch(/isSchedulerRunning:\s*\(\)\s*=>\s*financeReceiptIngestScheduler\?\.isEnabled\(\)\s*\?\?\s*false/);
    expect(callWindow).not.toMatch(/isSchedulerRunning:\s*\(\)\s*=>\s*financeReceiptIngestScheduler\s*!=\s*null/);
  });

  it('getPacingStatus reads the LIVE scheduler parameter, not a hardcoded stub', () => {
    const callWindow = financeRouterCall();
    expect(callWindow).toMatch(/getPacingStatus:\s*\(\)\s*=>\s*financeReceiptIngestScheduler\?\.status/);
  });

  it('main.ts awaits bootstrapFinanceReceiptsIngest() BEFORE createApp and passes the result in', () => {
    expect(mainSrc).toContain('bootstrapFinanceReceiptsIngest');
    const financeIdx = mainSrc.indexOf('await bootstrapFinanceReceiptsIngest()');
    const createAppIdx = mainSrc.indexOf('createApp(');
    expect(financeIdx).toBeGreaterThan(-1);
    expect(createAppIdx).toBeGreaterThan(-1);
    expect(financeIdx).toBeLessThan(createAppIdx);
    const createAppCall = mainSrc.slice(createAppIdx, createAppIdx + 200);
    expect(createAppCall).toContain('financeReceiptIngest');
  });

  it('main.ts starts the scheduler (dormant when null)', () => {
    expect(mainSrc).toMatch(/financeReceiptIngest\?\.start\(\)/);
  });

  // ── fix-wave-3 R9 — the 🔵 left open since fix-wave-1: nothing pinned
  // `bootstrapFinanceReceiptsIngest.ts`'s OWN wiring of `itemRepo`/`retencionRepo`
  // into the two use cases. Runtime guards (the constructors now throw when
  // either is falsy) catch a refactor that drops the ARGUMENTS entirely —
  // `tsc` would already refuse to compile that, since fix-wave-3 made both
  // params mandatory — but they can't catch a refactor that keeps the right
  // SHAPE while wiring the wrong variable (e.g. passing `invoiceTypes` twice).
  // A source-text pin (molde the rest of this file) closes that residual gap
  // cheaply, without needing a live Prisma connection to exercise bootstrap
  // itself.
  // Fase 2 — pins that the settables CRUD (technology-costs/plan-prices/
  // targets/inflation) is wired with REAL Prisma repos, not a fixture quietly
  // filtering into prod (same rationale as the Fase 1 pins above — a
  // composition-root gap here is invisible to unit tests, which always wire
  // their OWN in-memory doubles regardless of what app.ts actually does).
  describe('Fase 2: settables CRUD wiring', () => {
    it('imports the 4 new Prisma repos + their use cases', () => {
      expect(appSrc).toContain("from '../adapters/prisma/PrismaFinanceTechnologyCostRepository'");
      expect(appSrc).toContain("from '../adapters/prisma/PrismaFinancePlanPriceRepository'");
      expect(appSrc).toContain("from '../adapters/prisma/PrismaFinanceTargetsConfigRepository'");
      expect(appSrc).toContain("from '../adapters/prisma/PrismaFinanceInflationIndexRepository'");
    });

    it('wires all 8 Fase 2 use cases into createFinanceGrowthRouter with REAL repos', () => {
      const callWindow = financeRouterCall();
      expect(callWindow).toContain('new GetFinanceTechnologyCosts(financeTechnologyCostRepo, financeTechnologyCatalogRepo)');
      expect(callWindow).toContain('new UpdateFinanceTechnologyCost(financeTechnologyCostRepo, financeTechnologyCatalogRepo)');
      expect(callWindow).toContain('new GetFinancePlanPrices(financePlanPriceRepo, financePlanCatalogRepo)');
      expect(callWindow).toContain('new UpdateFinancePlanPrice(financePlanPriceRepo, financePlanCatalogRepo)');
      expect(callWindow).toContain('new GetFinanceTargets(financeTargetsConfigRepo)');
      expect(callWindow).toContain('new UpdateFinanceTargets(financeTargetsConfigRepo)');
      expect(callWindow).toContain('new ListFinanceInflationIndex(financeInflationIndexRepo)');
      expect(callWindow).toContain('new UpdateFinanceInflationIndex(financeInflationIndexRepo)');
    });

    // fix-wave-1 D — `Update*` must consult the SAME catalog repo instance
    // `Get*` uses (not a fresh, disconnected `new Prisma...Repository()` per
    // use case) — pins that the 404 guard is wired against the real catalog,
    // not silently dropped by a future refactor that re-inlines `new X()`.
    it("D: UpdateFinanceTechnologyCost/UpdateFinancePlanPrice share the catalog repo instance with their Get* siblings", () => {
      expect(appSrc).toMatch(/const financeTechnologyCatalogRepo = new PrismaContractTechnologyRepository\(\);/);
      expect(appSrc).toMatch(/const financePlanCatalogRepo = new PrismaPlanRepository\(\);/);
    });
  });

  // Fase 3 (task 3.28) — pins that the SECOND job (nightly MRR bridge/cohort
  // snapshot, design.md Wiring) is actually wired in main.ts and built with
  // REAL Prisma repos, not a fixture quietly filtering into prod. Unlike the
  // Fase 1 ingest scheduler, this job has no HTTP route depending on its live
  // instance, so it's fire-and-forget (molde bootstrapGestionRealSync) rather
  // than awaited-before-createApp — the pins reflect that shape.
  describe('Fase 3: nightly snapshot job wiring', () => {
    it('main.ts imports and starts bootstrapFinanceSnapshotJob (fire-and-forget, like gr-sync)', () => {
      expect(mainSrc).toContain("from './infrastructure/scheduling/bootstrapFinanceSnapshotJob'");
      expect(mainSrc).toContain('bootstrapFinanceSnapshotJob()');
      expect(mainSrc).toMatch(/bootstrapFinanceSnapshotJob\(\)\s*\n?\s*\.then\(\(scheduler\)\s*=>\s*scheduler\.start\(\)\)/);
    });

    it('bootstrapFinanceSnapshotJob wires BuildFinanceMonthlySnapshot/BuildFinanceCohortSnapshot with REAL Prisma repos', () => {
      expect(snapshotBootstrapSrc).toContain("from '../adapters/prisma/PrismaContractServiceEventRepository'");
      expect(snapshotBootstrapSrc).toContain("from '../adapters/prisma/PrismaFinanceMonthlySnapshotRepository'");
      expect(snapshotBootstrapSrc).toContain("from '../adapters/prisma/PrismaFinanceCohortSnapshotRepository'");
      expect(snapshotBootstrapSrc).toContain('new BuildFinanceMonthlySnapshot(');
      expect(snapshotBootstrapSrc).toContain('new BuildFinanceCohortSnapshot(');
      expect(snapshotBootstrapSrc).toContain('new FinanceSnapshotScheduler(');
    });

    it('uses its OWN PgAdvisoryLock/lock key, never sharing FinanceReceiptIngestScheduler\'s session', () => {
      const start = snapshotBootstrapSrc.indexOf('new FinanceSnapshotScheduler(');
      expect(start).toBeGreaterThan(-1);
      expect(snapshotBootstrapSrc).toContain('new PgAdvisoryLock()');
    });
  });

  describe('R9: bootstrapFinanceReceiptsIngest wires itemRepo/retencionRepo into BOTH use cases', () => {
    it('imports the real Prisma item/retención repos', () => {
      expect(bootstrapSrc).toContain("from '../adapters/prisma/PrismaFinanceReceiptItemRepository'");
      expect(bootstrapSrc).toContain("from '../adapters/prisma/PrismaFinanceReceiptRetencionRepository'");
    });

    it('SyncGrReceiptsDelta is constructed with itemRepo AND retencionRepo', () => {
      const start = bootstrapSrc.indexOf('new SyncGrReceiptsDelta(');
      expect(start).toBeGreaterThan(-1);
      const end = bootstrapSrc.indexOf(');', start);
      const call = bootstrapSrc.slice(start, end);
      expect(call).toMatch(/\bitemRepo\b/);
      expect(call).toMatch(/\bretencionRepo\b/);
    });

    it('SyncGrReceiptsBackfillBatch is constructed with itemRepo AND retencionRepo', () => {
      const start = bootstrapSrc.indexOf('new SyncGrReceiptsBackfillBatch(');
      expect(start).toBeGreaterThan(-1);
      const end = bootstrapSrc.indexOf(');', start);
      const call = bootstrapSrc.slice(start, end);
      expect(call).toMatch(/\bitemRepo\b/);
      expect(call).toMatch(/\bretencionRepo\b/);
    });
  });
});
