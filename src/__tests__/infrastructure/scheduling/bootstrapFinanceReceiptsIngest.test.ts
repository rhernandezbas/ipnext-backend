/**
 * gr-receipt-annulment fix-wave RF9 — the composition root is pinned three
 * ways today (type aridity, constructor throw, source-TEXT slices), and all
 * three are SHAPE pins: they check that a name appears in the right position.
 * None of them EXECUTES `bootstrapFinanceReceiptsIngest`, so a wiring with the
 * right shape and the wrong SEMANTICS passes every one of them — the probe
 * that motivated this test wired `{ pageSize: 0 }` into the lanes and sailed
 * through all three layers, producing an ingest that requests zero receipts
 * per page forever, with a green suite and a green `/sync/status`.
 *
 * This test builds the REAL object graph (no Prisma connection is opened: the
 * adapters connect lazily and nothing here calls `execute()`) and asserts the
 * properties the shape pins cannot see:
 *  1. every lane's effective page size is a usable positive number, and
 *  2. all three lanes read the SAME live config instance the scheduler reads —
 *     i.e. the DB knobs are actually alive, everywhere, at once.
 */
describe('bootstrapFinanceReceiptsIngest — executed, not just text-matched (RF9)', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  /** `config.ts` fail-fasts on these at import time (molde `config.grSyncEstados.test.ts`). */
  const REQUIRED_ENV = {
    SPLYNX_API_URL: 'http://x',
    SPLYNX_API_KEY: 'k',
    SPLYNX_API_SECRET: 's',
    JWT_SECRET: 'j',
    PORT: '3000',
  };
  const ENABLED_ENV = { ...REQUIRED_ENV, GR_SYNC_ENABLED: 'true', GR_CUIT: '20111111112', GR_SECRET: 'test-secret' };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priv = (o: unknown): any => o as any;

  /**
   * Boots the REAL composition root under `env`. The classes come from the
   * SAME freshly-reset module registry the bootstrap itself loaded — a
   * statically-imported class is a DIFFERENT object after `jest.resetModules()`,
   * and `toBeInstanceOf` would fail against an identically-named constructor.
   */
  async function bootstrapWith(env: Record<string, string | undefined>) {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, ...env };
    const mod = await import('@infrastructure/scheduling/bootstrapFinanceReceiptsIngest');
    const classes = {
      SyncGrReceiptsDelta: (await import('@application/use-cases/finance/SyncGrReceiptsDelta')).SyncGrReceiptsDelta,
      SyncGrReceiptsBackfillBatch: (await import('@application/use-cases/finance/SyncGrReceiptsBackfillBatch')).SyncGrReceiptsBackfillBatch,
      SyncGrReceiptsReconcileWindow: (await import('@application/use-cases/finance/SyncGrReceiptsReconcileWindow')).SyncGrReceiptsReconcileWindow,
      PrismaFinanceReceiptSyncConfigRepository: (await import('@infrastructure/adapters/prisma/PrismaFinanceReceiptSyncConfigRepository'))
        .PrismaFinanceReceiptSyncConfigRepository,
      FinanceReceiptIngestScheduler: (await import('@infrastructure/scheduling/FinanceReceiptIngestScheduler')).FinanceReceiptIngestScheduler,
    };
    return { scheduler: await mod.bootstrapFinanceReceiptsIngest(), classes };
  }

  it('returns a scheduler wired with the THREE real lanes', async () => {
    const { scheduler, classes } = await bootstrapWith(ENABLED_ENV);

    expect(scheduler).toBeInstanceOf(classes.FinanceReceiptIngestScheduler);
    expect(priv(scheduler).syncDelta).toBeInstanceOf(classes.SyncGrReceiptsDelta);
    expect(priv(scheduler).syncBackfill).toBeInstanceOf(classes.SyncGrReceiptsBackfillBatch);
    expect(priv(scheduler).syncReconcile).toBeInstanceOf(classes.SyncGrReceiptsReconcileWindow);
  });

  it('every lane ends up with a USABLE page size (> 0) — a `pageSize: 0` wiring passes every shape pin and then requests nothing, forever', async () => {
    const { scheduler } = await bootstrapWith(ENABLED_ENV);

    for (const lane of ['syncDelta', 'syncBackfill', 'syncReconcile']) {
      const pageSize = priv(priv(scheduler)[lane]).pageSize;
      expect(typeof pageSize).toBe('number');
      expect(pageSize).toBeGreaterThan(0);
    }
  });

  it('the THREE lanes and the scheduler all read the SAME live config instance — the DB knobs are alive on every carril, not just two', async () => {
    const { scheduler, classes } = await bootstrapWith(ENABLED_ENV);

    const schedulerCfg = priv(scheduler).syncConfig;
    expect(schedulerCfg).toBeInstanceOf(classes.PrismaFinanceReceiptSyncConfigRepository);
    // RF2 — the delta lane USED to have no config collaborator at all: its
    // annulment guard ran on hardcoded defaults, so an operator raising
    // `annulmentGuardMaxPct` for a legitimate 6%-annulment day changed nothing
    // on the lane that carries TODAY's cash.
    expect(priv(priv(scheduler).syncDelta).syncConfig).toBe(schedulerCfg);
    expect(priv(priv(scheduler).syncBackfill).syncConfig).toBe(schedulerCfg);
    expect(priv(priv(scheduler).syncReconcile).syncConfig).toBe(schedulerCfg);
  });

  it('the three lanes share ONE SyncState repo and ONE receipt repo (a per-lane copy would split the cursors and the annulment latch)', async () => {
    const { scheduler } = await bootstrapWith(ENABLED_ENV);

    const state = priv(scheduler).state;
    expect(priv(priv(scheduler).syncDelta).state).toBe(state);
    expect(priv(priv(scheduler).syncBackfill).state).toBe(state);
    expect(priv(priv(scheduler).syncReconcile).state).toBe(state);

    const receiptRepo = priv(priv(scheduler).syncDelta).receiptRepo;
    expect(priv(priv(scheduler).syncBackfill).receiptRepo).toBe(receiptRepo);
    expect(priv(priv(scheduler).syncReconcile).receiptRepo).toBe(receiptRepo);
  });

  it('returns null (dormant, no object graph at all) when GR itself is off', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { scheduler } = await bootstrapWith({ ...ENABLED_ENV, GR_SYNC_ENABLED: 'false' });
    logSpy.mockRestore();
    expect(scheduler).toBeNull();
  });

  it('returns null when GR credentials are missing — never a half-wired scheduler', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { scheduler } = await bootstrapWith({ ...ENABLED_ENV, GR_SECRET: '' });
    warnSpy.mockRestore();
    expect(scheduler).toBeNull();
  });
});
