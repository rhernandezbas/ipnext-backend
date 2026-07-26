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

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
    mainSrc = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');
    bootstrapSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'scheduling', 'bootstrapFinanceReceiptsIngest.ts'), 'utf8');
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
