import { persistReceiptPage } from '@application/use-cases/finance/financeReceiptPageIngest';
import { mapGrReceipt } from '@application/use-cases/finance/mapGrReceipt';
import { readSnapshotRebuildQueue } from '@application/use-cases/finance/financeSnapshotRebuildQueue';
import { FinanceSnapshotScheduler } from '@infrastructure/scheduling/FinanceSnapshotScheduler';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { InMemoryFinancePaymentReceiptRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePaymentReceiptRepository';
import { InMemoryFinanceReceiptApplicationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptApplicationRepository';
import { InMemoryFinanceInvoiceTypeClassificationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceInvoiceTypeClassificationRepository';
import { InMemoryFinanceReceiptItemRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptItemRepository';
import { InMemoryFinanceReceiptRetencionRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptRetencionRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { GrReceipt } from '@domain/entities/gestionReal';

function grReceipt(id: string, opts: { fechaRecibo: string; fechaAnulacion?: string | null; tipo?: string; importe?: number } = { fechaRecibo: '05-08-2026' }): GrReceipt {
  const importe = opts.importe ?? 1000;
  return {
    grReceiptId: id,
    clienteGrId: '100011',
    recaudador: 'mercadopago',
    fechaRecibo: opts.fechaRecibo,
    fechaConfirmacion: null,
    fechaAnulacion: opts.fechaAnulacion ?? null,
    observaciones: null,
    applications: [{ grApplicationId: `${id}-a1`, tipo: opts.tipo ?? 'FB', sucursal: '00010', numero: id, importe, fecha: opts.fechaRecibo }],
    items: [{ grItemId: `${id}-i1`, banco: null, cajaCuentaId: null, destino: null, fecha: opts.fechaRecibo, importe, moneda: null, numeroTransferencia: null, tipo: null }],
    retenciones: [],
  } as GrReceipt;
}

function makeRepos() {
  const receiptRepo = new InMemoryFinancePaymentReceiptRepository();
  const applicationRepo = new InMemoryFinanceReceiptApplicationRepository(receiptRepo);
  const itemRepo = new InMemoryFinanceReceiptItemRepository(receiptRepo);
  const retencionRepo = new InMemoryFinanceReceiptRetencionRepository();
  const invoiceTypes = new InMemoryFinanceInvoiceTypeClassificationRepository();
  const syncState = new InMemorySyncStateRepository();
  return { receiptRepo, applicationRepo, itemRepo, retencionRepo, invoiceTypes, syncState };
}

const NOW = new Date('2026-08-10T14:00:00Z'); // AR: 10-08-2026 → nightly horizon = [2026-07, 2026-08]

describe('persistReceiptPage', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  // ── fix-wave RF1 — a FLIP (row already mirrored as anulado:false, GR now
  // reports it annulled) is the ONE event on this path that silently changes
  // money already reported. It gets a loud line with the RAW value, because
  // the latch is one-way: reversing a FALSE annulment is a human's SQL, and a
  // human needs to be able to find it.
  describe('RF1: the per-flip audit log', () => {
    it('logs a flip LOUDLY, with the receipt id and the RAW fecha_anulacion', async () => {
      const repos = makeRepos();
      await persistReceiptPage([mapGrReceipt(grReceipt('R1', { fechaRecibo: '05-08-2026' }))], repos, 'reconcile', NOW);
      warnSpy.mockClear();

      await persistReceiptPage(
        [mapGrReceipt(grReceipt('R1', { fechaRecibo: '05-08-2026', fechaAnulacion: '09-08-2026 10:00:00' }))],
        repos,
        'reconcile',
        NOW,
      );

      const line = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('ANULACION'));
      expect(line).toBeDefined();
      expect(line).toContain('recibo=R1');
      expect(line).toContain('anulado:false->true');
      expect(line).toContain('fecha_anulacion_cruda="09-08-2026 10:00:00"');
    });

    it('a receipt that arrives ALREADY annulled (never mirrored before) is NOT a flip — nothing was ever counted, nothing to audit', async () => {
      const repos = makeRepos();

      await persistReceiptPage(
        [mapGrReceipt(grReceipt('R9', { fechaRecibo: '05-08-2026', fechaAnulacion: '09-08-2026 10:00:00' }))],
        repos,
        'reconcile',
        NOW,
      );

      expect(warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('ANULACION'))).toHaveLength(0);
      expect(repos.receiptRepo.rows.get('R9')?.anulado).toBe(true);
    });

    it('re-persisting an ALREADY-annulled receipt does not re-log the flip every sweep (it is not a flip anymore)', async () => {
      const repos = makeRepos();
      const annulled = () => mapGrReceipt(grReceipt('R2', { fechaRecibo: '05-08-2026', fechaAnulacion: '09-08-2026 10:00:00' }));
      await persistReceiptPage([mapGrReceipt(grReceipt('R2', { fechaRecibo: '05-08-2026' }))], repos, 'reconcile', NOW);
      await persistReceiptPage([annulled()], repos, 'reconcile', NOW);
      warnSpy.mockClear();

      await persistReceiptPage([annulled()], repos, 'reconcile', NOW);

      expect(warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('ANULACION'))).toHaveLength(0);
    });
  });

  // ── fix-wave RF3 — the invariant that replaced the (arithmetically false)
  // "ventana >= rebuild" floor. `[mes anterior, mes corriente]` guarantees only
  // 28 days on the 1st of a month; a receipt older than that can still flip
  // inside the reconcile window, and its month's snapshot would keep the cash
  // FOREVER. Whenever that happens the month is queued for an explicit rebuild.
  describe('RF3: an out-of-horizon flip queues its month for a snapshot rebuild', () => {
    it('a flip on a month OUTSIDE [mes anterior, mes corriente] queues that month', async () => {
      const repos = makeRepos();
      // now = 10-08-2026 (horizon 2026-07/2026-08); this receipt is from January.
      await persistReceiptPage([mapGrReceipt(grReceipt('R3', { fechaRecibo: '31-01-2026' }))], repos, 'reconcile', NOW);

      await persistReceiptPage(
        [mapGrReceipt(grReceipt('R3', { fechaRecibo: '31-01-2026', fechaAnulacion: '09-08-2026 10:00:00' }))],
        repos,
        'reconcile',
        NOW,
      );

      expect(await readSnapshotRebuildQueue(repos.syncState)).toEqual(['2026-01']);
    });

    // RFX1 renamed this: the predicate is no longer "inside the horizon" but
    // "is the CURRENT month". `05-08-2026` with now=10-08-2026 is the current
    // month either way, so the CASE is unchanged — only its justification is.
    it('a flip on the CURRENT month queues nothing — every nightly run recomputes the current month', async () => {
      const repos = makeRepos();
      await persistReceiptPage([mapGrReceipt(grReceipt('R4', { fechaRecibo: '05-08-2026' }))], repos, 'reconcile', NOW);

      await persistReceiptPage(
        [mapGrReceipt(grReceipt('R4', { fechaRecibo: '05-08-2026', fechaAnulacion: '09-08-2026 10:00:00' }))],
        repos,
        'reconcile',
        NOW,
      );

      expect(await readSnapshotRebuildQueue(repos.syncState)).toEqual([]);
    });

    it('a receipt that arrives already annulled queues nothing — no snapshot ever counted it', async () => {
      const repos = makeRepos();

      await persistReceiptPage(
        [mapGrReceipt(grReceipt('R5', { fechaRecibo: '31-01-2026', fechaAnulacion: '09-08-2026 10:00:00' }))],
        repos,
        'reconcile',
        NOW,
      );

      expect(await readSnapshotRebuildQueue(repos.syncState)).toEqual([]);
    });

    it('the BACKFILL lane queues too — the repair is a property of the flip, not of which lane saw it', async () => {
      const repos = makeRepos();
      await persistReceiptPage([mapGrReceipt(grReceipt('R6', { fechaRecibo: '15-03-2015' }))], repos, 'backfill', NOW);

      await persistReceiptPage(
        [mapGrReceipt(grReceipt('R6', { fechaRecibo: '15-03-2015', fechaAnulacion: '09-08-2026 10:00:00' }))],
        repos,
        'backfill',
        NOW,
      );

      expect(await readSnapshotRebuildQueue(repos.syncState)).toEqual(['2015-03']);
    });

    it('the month is queued BEFORE the rows are written — a failing write must never leave a flip persisted with no rebuild pending', async () => {
      const repos = makeRepos();
      await persistReceiptPage([mapGrReceipt(grReceipt('R7', { fechaRecibo: '31-01-2026' }))], repos, 'reconcile', NOW);
      jest.spyOn(repos.applicationRepo, 'upsertBatch').mockRejectedValue(new Error('P2000: boom'));

      await expect(
        persistReceiptPage(
          [mapGrReceipt(grReceipt('R7', { fechaRecibo: '31-01-2026', fechaAnulacion: '09-08-2026 10:00:00' }))],
          repos,
          'reconcile',
          NOW,
        ),
      ).rejects.toThrow();

      // A redundant queued month costs one idempotent rebuild; the inverse
      // (written flip, nothing queued) is unrecoverable — the row is no longer
      // a flip on the retry, so the month would never be queued again.
      expect(await readSnapshotRebuildQueue(repos.syncState)).toEqual(['2026-01']);
    });
  });

  // ── fix-wave-2 RFX1 — the enqueue decision used to ask "is this month
  // INSIDE the nightly rebuild horizon?" using the INGEST's clock, while the
  // nightly job recomputes its horizon with ITS OWN clock, hours later. When
  // the two clocks straddle a month boundary the ingest says "covered" about a
  // horizon that no longer exists by the time the nightly runs, and the month
  // is never repaired — a ~21 h blind window every single month.
  //
  // The rule is now clock-race-free BY CONSTRUCTION: a flip is queued unless
  // its month is the CURRENT one (AR) at ingest time. These tests trace BOTH
  // clocks, because a test that only ever looks at the ingest clock is exactly
  // what let the bug through.
  describe('RFX1: the enqueue rule is "not the CURRENT month", not "inside the nightly horizon"', () => {
    function nightly(state: InMemorySyncStateRepository, clockIso: string, monthlyCalls: string[]): FinanceSnapshotScheduler {
      const buildMonthly = {
        execute: jest.fn(async (ym: string) => {
          monthlyCalls.push(ym);
          return { yearMonth: ym };
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buildCohort = { execute: jest.fn(async () => []) } as any;
      return new FinanceSnapshotScheduler(
        buildMonthly,
        buildCohort,
        { intervalMs: 999999, cohortLookbackMonths: 0, silent: true },
        new InMemoryDistributedLock(),
        () => new Date(clockIso),
        state,
      );
    }

    async function flip(repos: ReturnType<typeof makeRepos>, id: string, fechaRecibo: string, at: Date): Promise<void> {
      await persistReceiptPage([mapGrReceipt(grReceipt(id, { fechaRecibo }))], repos, 'reconcile', at);
      await persistReceiptPage(
        [mapGrReceipt(grReceipt(id, { fechaRecibo, fechaAnulacion: '28-02-2026 20:00:00' }))],
        repos,
        'reconcile',
        at,
      );
    }

    // 28-02-2026 20:00 ART = 2026-02-28T23:00:00Z. The INGEST clock still reads
    // February, so `[mes anterior, mes corriente]` = [2026-01, 2026-02] LOOKS
    // like it covers January — but the next nightly fires after AR midnight,
    // in March, with horizon [2026-02, 2026-03].
    const FLIP_28_FEB_20H_ART = new Date('2026-02-28T23:00:00Z');

    it('P1: a flip on the previous month, hours before the month rolls over, IS queued', async () => {
      const repos = makeRepos();

      await flip(repos, 'X1', '28-01-2026', FLIP_28_FEB_20H_ART);

      expect(await readSnapshotRebuildQueue(repos.syncState)).toEqual(['2026-01']);
    });

    it('P1 traced with BOTH clocks: the next nightly runs in MARCH, and only the queue makes it rebuild January', async () => {
      const repos = makeRepos();
      await flip(repos, 'X2', '28-01-2026', FLIP_28_FEB_20H_ART);

      const monthlyCalls: string[] = [];
      // 01-03-2026 03:00 ART — horizon [2026-02, 2026-03]. January is gone.
      await nightly(repos.syncState, '2026-03-01T06:00:00Z', monthlyCalls).runOnce();

      expect(monthlyCalls).toContain('2026-01');
      expect(await readSnapshotRebuildQueue(repos.syncState)).toEqual([]);
    });

    it('CONTROL: the same flip a day earlier was already safe — a nightly still inside February rebuilds January by horizon alone', async () => {
      const repos = makeRepos();
      await flip(repos, 'X3', '28-01-2026', new Date('2026-02-27T23:00:00Z'));

      const monthlyCalls: string[] = [];
      // 28-02-2026 03:00 ART — horizon [2026-01, 2026-02].
      await nightly(repos.syncState, '2026-02-28T06:00:00Z', monthlyCalls).runOnce();

      expect(monthlyCalls).toContain('2026-01');
      expect(await readSnapshotRebuildQueue(repos.syncState)).toEqual([]);
    });

    it('the redundancy of queuing a month the nightly ALREADY covers costs ZERO extra rebuilds', async () => {
      const repos = makeRepos();
      // now = 10-08-2026 → the previous month (2026-07) is inside the horizon.
      await flip(repos, 'X4', '15-07-2026', NOW);
      expect(await readSnapshotRebuildQueue(repos.syncState)).toEqual(['2026-07']);

      const monthlyCalls: string[] = [];
      await nightly(repos.syncState, '2026-08-11T06:00:00Z', monthlyCalls).runOnce();

      // Rebuilt ONCE, by the horizon pass — `extraQueued` filters it out — and
      // the queue is cleared all the same. This is the whole cost of dropping
      // the horizon check: one deduplicated row in a `SyncState.cursor`.
      expect(monthlyCalls).toEqual(['2026-07', '2026-08']);
      expect(await readSnapshotRebuildQueue(repos.syncState)).toEqual([]);
    });

    it('BORDER: a CURRENT-month flip at 23:59 of the last day is NOT queued — the next nightly covers it as the PREVIOUS month', async () => {
      const repos = makeRepos();
      // 28-02-2026 23:59 ART = 2026-03-01T02:59:00Z — still February in AR.
      await flip(repos, 'X5', '15-02-2026', new Date('2026-03-01T02:59:00Z'));

      expect(await readSnapshotRebuildQueue(repos.syncState)).toEqual([]);

      const monthlyCalls: string[] = [];
      // Any nightly run in March has 2026-02 as its `mes anterior`.
      await nightly(repos.syncState, '2026-03-02T06:00:00Z', monthlyCalls).runOnce();

      expect(monthlyCalls).toContain('2026-02');
    });
  });

  // ── fix-wave RF16 — an annulled receipt is a historical record, not a
  // source of truth about the catalog or about the aplicaciones identity.
  describe('RF16: annulled receipts do not feed grType auto-alta nor the identity warning', () => {
    it('a grType seen ONLY on an annulled receipt is never auto-registered (no phantom classification to bucket by hand)', async () => {
      const repos = makeRepos();

      await persistReceiptPage(
        [mapGrReceipt(grReceipt('R8', { fechaRecibo: '05-08-2026', fechaAnulacion: '09-08-2026 10:00:00', tipo: 'ZZ' }))],
        repos,
        'reconcile',
        NOW,
      );

      expect(await repos.invoiceTypes.get('ZZ')).toBeNull();
    });

    it('the SAME grType on a healthy receipt IS auto-registered (the skip is scoped to annulled rows, not to the feature)', async () => {
      const repos = makeRepos();

      await persistReceiptPage([mapGrReceipt(grReceipt('R8b', { fechaRecibo: '05-08-2026', tipo: 'ZZ' }))], repos, 'reconcile', NOW);

      expect((await repos.invoiceTypes.get('ZZ'))?.bucket).toBe('unclassified');
    });

    it('an annulled receipt whose aplicaciones != items+retenciones does NOT emit the identity warning (voided receipts keep partial children by nature)', async () => {
      const repos = makeRepos();
      const mapped = mapGrReceipt(grReceipt('R10', { fechaRecibo: '05-08-2026', fechaAnulacion: '09-08-2026 10:00:00' }));
      mapped.items = []; // aplicaciones 1000 vs items 0 — a mismatch on paper

      await persistReceiptPage([mapped], repos, 'reconcile', NOW);

      expect(warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('identity mismatch'))).toHaveLength(0);
    });

    it('a HEALTHY receipt with the same mismatch still warns — the guard itself is intact', async () => {
      const repos = makeRepos();
      const mapped = mapGrReceipt(grReceipt('R11', { fechaRecibo: '05-08-2026' }));
      mapped.items = [];

      await persistReceiptPage([mapped], repos, 'reconcile', NOW);

      expect(warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('identity mismatch'))).toHaveLength(1);
    });

    it('the annulled receipt and its children are STILL persisted — only the two inferences skip it', async () => {
      const repos = makeRepos();

      await persistReceiptPage(
        [mapGrReceipt(grReceipt('R12', { fechaRecibo: '05-08-2026', fechaAnulacion: '09-08-2026 10:00:00', tipo: 'ZZ' }))],
        repos,
        'reconcile',
        NOW,
      );

      expect(repos.receiptRepo.rows.get('R12')?.anulado).toBe(true);
      expect(repos.applicationRepo.rows.size).toBe(1);
      expect(repos.itemRepo.rows.size).toBe(1);
    });
  });
});
