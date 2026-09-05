import { parseReceiptsResponse } from '@infrastructure/adapters/gestion-real/GestionRealClient';
import { GestionRealPort, FetchReceiptsParams, FetchReceiptsResult } from '@domain/ports/GestionRealPort';
import { SyncGrReceiptsDelta } from '@application/use-cases/finance/SyncGrReceiptsDelta';
import { SyncGrReceiptsBackfillBatch } from '@application/use-cases/finance/SyncGrReceiptsBackfillBatch';
import { FinanceReceiptIngestScheduler } from '@infrastructure/scheduling/FinanceReceiptIngestScheduler';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { InMemoryFinanceReceiptSyncConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptSyncConfigRepository';
import { InMemoryFinancePaymentReceiptRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePaymentReceiptRepository';
import { InMemoryFinanceReceiptApplicationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptApplicationRepository';
import { InMemoryFinanceInvoiceTypeClassificationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceInvoiceTypeClassificationRepository';
import { InMemoryFinanceReceiptItemRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptItemRepository';
import { InMemoryFinanceReceiptRetencionRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptRetencionRepository';
import { FinanceReceiptApplication } from '@domain/ports/FinanceReceiptApplicationRepository';
import { FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS } from '@domain/ports/FinanceReceiptSyncConfigRepository';
import { SyncGrReceiptsReconcileWindow, RECONCILE_ENTITY } from '@application/use-cases/finance/SyncGrReceiptsReconcileWindow';
import { FinanceReceiptAnnulmentGuardError } from '@application/use-cases/finance/financeIngestErrors';

const DELTA_ENTITY = 'finance-receipts-delta';
const BACKFILL_ENTITY = 'finance-receipts-backfill';

/**
 * Test-only `GestionRealPort` that goes through the REAL exported parser
 * (`parseReceiptsResponse`) on a raw, GR-shaped JSON payload — unlike
 * `InMemoryGestionRealPort`, which hands back an already-normalized
 * `GrReceipt[]` and completely bypasses `GestionRealClient`'s parsing logic
 * (fix-wave-1 hueco de cobertura #2: "los tests de use case pasan por
 * InMemoryGestionRealPort... salteando el parser por completo").
 */
class RawPayloadGestionRealPort implements GestionRealPort {
  /** One raw HTTP-response-shaped payload per call, consumed in order (used when `responder` is unset). */
  rawResponses: unknown[] = [];
  /** When set, computes the raw payload FROM the request params (needed once two lanes share one port). */
  responder?: (params: FetchReceiptsParams) => unknown;
  calls: FetchReceiptsParams[] = [];

  async fetchReceipts(params: FetchReceiptsParams): Promise<FetchReceiptsResult> {
    this.calls.push(params);
    const raw = this.responder
      ? this.responder(params)
      : (this.rawResponses.shift() ?? { error: 0, resultados: '0', recibos: {} });
    return parseReceiptsResponse(raw);
  }

  // Unused by this seam — finance-growth Fase 1 only needs fetchReceipts.
  fetchClients = (): never => { throw new Error('not used in this seam'); };
  fetchContractsByClient = (): never => { throw new Error('not used in this seam'); };
  fetchClientBalance = (): never => { throw new Error('not used in this seam'); };
  getServiceOrders = (): never => { throw new Error('not used in this seam'); };
  fetchContractsModifiedSince = (): never => { throw new Error('not used in this seam'); };
  fetchClientReceipts = (): never => { throw new Error('not used in this seam'); };
}

/**
 * REAL measured GR shape (fix-wave-1 F1/F2 + fix-wave-2 R1/LOW). This fixture
 * previously LIED on 3 counts, measured live against 4.839 real June-2026
 * recibos: `importe` is ALWAYS a string (`"19999.00"`), never a JSON number;
 * `fecha_recibo` is DATE-ONLY (`"15-07-2026"`, no time — `fecha_confirmacion`
 * is the field that carries one); and `items`/`retenciones` were missing
 * entirely. `items` defaults to a single line matching `importe` exactly (cash
 * == aplicaciones, the common case) and `retenciones` defaults to none —
 * callers that need the "retenciones without items" scenario (R1) pass
 * `opts.items`/`opts.retenciones` explicitly.
 */
function rawReciboPayload(
  receiptKey: string,
  clienteId: string,
  importe: number,
  fechaDDMMYYYY: string,
  opts: { items?: unknown; retenciones?: unknown } = {},
) {
  return {
    error: 0,
    resultados: '1',
    recibos: {
      [receiptKey]: {
        cliente: { cliente_id: clienteId, nombre: 'CLIENTE DE PRUEBA' },
        recaudador: 'mercadopago',
        fecha_recibo: fechaDDMMYYYY,
        fecha_confirmacion: `${fechaDDMMYYYY} 10:05:00`,
        fecha_anulacion: '00-00-0000 00:00:00',
        observaciones: null,
        aplicaciones: {
          '1': { tipo: 'FB', sucursal: '00010', numero: `000${receiptKey}`, importe: importe.toFixed(2), fecha: fechaDDMMYYYY },
        },
        items:
          opts.items ??
          {
            '1': {
              banco: 'BANCO NACION',
              caja_cuenta_id: '1',
              destino: 'CTA CTE',
              fecha: fechaDDMMYYYY,
              importe: importe.toFixed(2),
              moneda: 'PES',
              numero_transferencia: '000123',
              tipo: 'transferencia',
            },
          },
        retenciones: opts.retenciones ?? {},
      },
    },
  };
}

describe('finance-receipts-ingest seam — raw payload → REAL parser → REAL use case → in-memory repo', () => {
  it('a raw GR-shaped payload survives the full seam with correct fechaRecibo/clienteGrId/grApplicationId', async () => {
    const gr = new RawPayloadGestionRealPort();
    gr.rawResponses.push(rawReciboPayload('9001', '100011', 1500, '15-07-2026'));
    const state = new InMemorySyncStateRepository();
    const receiptRepo = new InMemoryFinancePaymentReceiptRepository();
    const applicationRepo = new InMemoryFinanceReceiptApplicationRepository(receiptRepo);
    const invoiceTypes = new InMemoryFinanceInvoiceTypeClassificationRepository();
    const uc = new SyncGrReceiptsDelta(
      gr, state, receiptRepo, applicationRepo, invoiceTypes,
      new InMemoryFinanceReceiptSyncConfigRepository(),
      new InMemoryFinanceReceiptItemRepository(),
      new InMemoryFinanceReceiptRetencionRepository(),
      { now: () => new Date('2026-07-15T14:00:00Z') },
    );

    await uc.execute();

    expect(receiptRepo.rows.size).toBe(1);
    const receipt = receiptRepo.rows.get('9001');
    expect(receipt?.clientGrId).toBe('100011'); // F2: resolved from the NESTED cliente.cliente_id
    expect(receipt?.fechaRecibo?.toISOString()).toBe('2026-07-15T03:00:00.000Z'); // F1: resolved from fecha_recibo

    expect(applicationRepo.rows.size).toBe(1);
    const app = applicationRepo.rows.get('9001-1'); // F11: synthetic id, receipt-scoped
    expect(app).toBeDefined();
    expect(app?.amount).toBe(1500);

    const listed = await applicationRepo.listByClientAndMonth('100011', '2026-07');
    expect(listed).toHaveLength(1); // Capa B attribution actually resolves — F2 was the reason it returned [] before

    const fb = await invoiceTypes.get('FB');
    expect(fb?.bucket).toBe('unclassified'); // auto-alta on first sight, never assumed 'revenue'
  });

  // ── fix-wave-2 R1 — `retenciones`/`items` were discarded entirely; the
  // "cobranza" (cash collected, spec.md) was computed as SUM(aplicaciones),
  // overstating collected cash by exactly the retenciones total. Ground truth
  // (recibo `333605`, June 2026): aplicaciones 20.850,60 == retenciones
  // 20.850,60, cash (items) 0,00 — a receipt that is 100% tax certificate,
  // zero actual cash. Before the fix there was NO way to tell these apart
  // (retenciones were never persisted); this test locks the split.
  it('R1: a receipt with retenciones and NO items persists cash (items) as 0 and the retención as its own line, never conflated with aplicaciones', async () => {
    const gr = new RawPayloadGestionRealPort();
    gr.rawResponses.push(
      rawReciboPayload('333605', '100022', 20850.6, '15-07-2026', {
        items: {}, // measured: 7/18 June-2026 receipts with retenciones have NO items at all
        retenciones: { '1': { tipo: 'retgan', importe: '20850.60', fecha: '15-07-2026' } },
      }),
    );
    const state = new InMemorySyncStateRepository();
    const receiptRepo = new InMemoryFinancePaymentReceiptRepository();
    const applicationRepo = new InMemoryFinanceReceiptApplicationRepository(receiptRepo);
    const invoiceTypes = new InMemoryFinanceInvoiceTypeClassificationRepository();
    const itemRepo = new InMemoryFinanceReceiptItemRepository();
    const retencionRepo = new InMemoryFinanceReceiptRetencionRepository();
    const uc = new SyncGrReceiptsDelta(
      gr, state, receiptRepo, applicationRepo, invoiceTypes,
      new InMemoryFinanceReceiptSyncConfigRepository(),
      itemRepo, retencionRepo,
      { now: () => new Date('2026-07-15T14:00:00Z') },
    );

    await uc.execute();

    // `aplicaciones` (debt cancelled) is STILL fully persisted — Decision 0/0b
    // doesn't touch it, it just stops being MISTAKEN for cash.
    const app = applicationRepo.rows.get('333605-1');
    expect(app?.amount).toBe(20850.6);

    // The cash actually received for this receipt is ZERO — no `items` line.
    const cashForReceipt = Array.from(itemRepo.rows.values())
      .filter((i) => i.receiptId === '333605')
      .reduce((sum, i) => sum + i.amount, 0);
    expect(cashForReceipt).toBe(0);

    // The retención is persisted as its OWN line, separate from both aplicaciones and items.
    expect(retencionRepo.rows.size).toBe(1);
    const ret = retencionRepo.rows.get('333605-ret-1');
    expect(ret).toMatchObject({ receiptId: '333605', tipo: 'retgan', amount: 20850.6 });
  });

  // ── fix-wave-2 R1 — identity guard: SUM(aplicaciones) == SUM(items) +
  // SUM(retenciones), measured EXACT across 4.839 real June-2026 receipts.
  it('R1: the identity SUM(aplicaciones) == SUM(items) + SUM(retenciones) holds for a receipt with all three nodes', async () => {
    const gr = new RawPayloadGestionRealPort();
    gr.rawResponses.push(
      rawReciboPayload('7002', '100033', 1000, '15-07-2026', {
        items: { '1': { banco: 'BANCO', caja_cuenta_id: '1', destino: 'CTA', fecha: '15-07-2026', importe: '700.00', moneda: 'PES', numero_transferencia: '1', tipo: 'transferencia' } },
        retenciones: { '1': { tipo: 'retiva', importe: '300.00', fecha: '15-07-2026' } },
      }),
    );
    const state = new InMemorySyncStateRepository();
    const receiptRepo = new InMemoryFinancePaymentReceiptRepository();
    const applicationRepo = new InMemoryFinanceReceiptApplicationRepository(receiptRepo);
    const invoiceTypes = new InMemoryFinanceInvoiceTypeClassificationRepository();
    const itemRepo = new InMemoryFinanceReceiptItemRepository();
    const retencionRepo = new InMemoryFinanceReceiptRetencionRepository();
    const uc = new SyncGrReceiptsDelta(
      gr, state, receiptRepo, applicationRepo, invoiceTypes,
      new InMemoryFinanceReceiptSyncConfigRepository(),
      itemRepo, retencionRepo,
      { now: () => new Date('2026-07-15T14:00:00Z') },
    );

    await uc.execute();

    const sumApplications = Array.from(applicationRepo.rows.values()).reduce((s, a) => s + a.amount, 0);
    const sumItems = Array.from(itemRepo.rows.values()).reduce((s, i) => s + i.amount, 0);
    const sumRetenciones = Array.from(retencionRepo.rows.values()).reduce((s, r) => s + r.amount, 0);
    expect(sumApplications).toBe(1000);
    expect(sumItems + sumRetenciones).toBe(1000);
  });

  it('a GR error envelope (HTTP 200, {"error":"91",...}) propagates through the REAL parser and use case as a thrown error, cursor untouched', async () => {
    const gr = new RawPayloadGestionRealPort();
    gr.rawResponses.push({ error: '91', descripcion: 'No Se indicó la Acción' });
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: DELTA_ENTITY, cursor: '14-07-2026', lastRunAt: null, lastResult: 'ok', itemsSynced: 3 });
    const uc = new SyncGrReceiptsDelta(
      gr, state,
      new InMemoryFinancePaymentReceiptRepository(),
      new InMemoryFinanceReceiptApplicationRepository(),
      new InMemoryFinanceInvoiceTypeClassificationRepository(),
      new InMemoryFinanceReceiptSyncConfigRepository(),
      new InMemoryFinanceReceiptItemRepository(),
      new InMemoryFinanceReceiptRetencionRepository(),
      { now: () => new Date('2026-07-15T14:00:00Z') },
    );

    await expect(uc.execute()).rejects.toThrow(/91/);

    const saved = await state.get(DELTA_ENTITY);
    expect(saved?.lastResult).toMatch(/^error:/);
    // The days in [14-07-2026, 15-07-2026] are NOT silently marked covered —
    // this is exactly the F3 failure mode (GR errors masquerading as an empty range).
    expect(saved?.cursor).not.toBe('15-07-2026');
  });
});

/**
 * fix-wave-1 F4 seam test (hueco de cobertura #4 — "no existe ningún test que
 * combine los DOS use cases REALES con el scheduler"). REAL `SyncGrReceiptsDelta`
 * + REAL `SyncGrReceiptsBackfillBatch` + REAL `FinanceReceiptIngestScheduler`,
 * with a POISONED application repo reproducing the exact probe from the
 * findings doc: "apps.upsertBatch tira P2000 por UN recibo con importe
 * podrido" — a sustained delta failure must NOT starve the backfill lane.
 */
class PoisonedApplicationRepo extends InMemoryFinanceReceiptApplicationRepository {
  async upsertBatch(applications: FinanceReceiptApplication[]): Promise<void> {
    if (applications.some((a) => a.amount === 999999999)) {
      throw new Error('P2000: value too long for column importe');
    }
    return super.upsertBatch(applications);
  }
}

describe('finance-receipts-ingest seam — F4 anti-starvation with the REAL use cases + REAL scheduler', () => {
  it('a poisoned recibo keeps the delta failing every tick, but the backfill STILL progresses over N ticks (was: 0 calls)', async () => {
    const gr = new RawPayloadGestionRealPort();
    // Lane-aware responder — delta always requests fechaDesde===fechaHasta
    // ("today"); the backfill requests a whole-month range. Every delta call
    // trips the poison (GR itself is healthy; the PERSISTENCE layer is what's
    // degraded — F4's second failure mode, the one F5 makes visible to the
    // scheduler at all: before F5 this failure never reached SyncState). The
    // backfill's own pages are healthy throughout.
    let poisonCounter = 0;
    let okCounter = 0;
    gr.responder = (params) => {
      if (params.fechaDesde === params.fechaHasta) {
        return rawReciboPayload(`poison-${poisonCounter++}`, '100099', 999999999, '15-07-2026');
      }
      return rawReciboPayload(`ok-${okCounter++}`, '100011', 1000, '10-07-2026');
    };

    const state = new InMemorySyncStateRepository();
    const receiptRepo = new InMemoryFinancePaymentReceiptRepository();
    const applicationRepo = new PoisonedApplicationRepo(receiptRepo);
    const invoiceTypes = new InMemoryFinanceInvoiceTypeClassificationRepository();
    const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
    // gr-receipt-annulment — reconcile stays OUT of this test's dynamics on
    // purpose: this test is specifically about delta-vs-backfill F4
    // starvation with the REAL use cases; a real reconcile lane would be a
    // THIRD variable in a test that already isolates two. The dedicated
    // 3-lane arbitration seam (task 5.7, "S6") exercises reconcile for real.
    await syncConfig.update({ backfillFloorYearMonth: '2026-01', reconcileEnabled: false });

    const now = () => new Date('2026-07-15T14:00:00Z');
    const itemRepo = new InMemoryFinanceReceiptItemRepository();
    const retencionRepo = new InMemoryFinanceReceiptRetencionRepository();
    const syncDelta = new SyncGrReceiptsDelta(gr, state, receiptRepo, applicationRepo, invoiceTypes, syncConfig, itemRepo, retencionRepo, { now });
    const syncBackfill = new SyncGrReceiptsBackfillBatch(gr, state, receiptRepo, applicationRepo, invoiceTypes, syncConfig, itemRepo, retencionRepo, { now });
    const noopReconcile = { execute: async () => ({ pageProcessed: 0, sweepInProgress: false, windowFrom: null, windowTo: null }) };

    const lock = new InMemoryDistributedLock();
    const scheduler = new FinanceReceiptIngestScheduler(syncDelta, syncBackfill, state, lock, syncConfig, noopReconcile as never, { silent: true, now });

    for (let i = 0; i < 30; i++) {
      await scheduler.tick();
      // fix-wave-3 R8 — the whole point: a delta PERSISTENCE failure (GR is
      // healthy, `applicationRepo.upsertBatch` is what's poisoned) must NEVER
      // escalate the SHARED request-pacing backoff. Before the fix this
      // reached `maxRequestIntervalMs` (300000ms) after 4 failures and stayed
      // there for the rest of the run — the exact ~15x backfill slowdown R8
      // reports. Asserted on EVERY tick, not just at the end, because the old
      // bug would have failed this from tick 5 onward.
      expect(scheduler.status.effectiveIntervalMs).toBe(FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.requestIntervalMs);
    }

    const deltaState = await state.get(DELTA_ENTITY);
    const backfillState = await state.get(BACKFILL_ENTITY);

    // The delta stays visibly broken (F5: the failure IS recorded, not swallowed).
    expect(deltaState?.lastResult).toMatch(/^error:/);
    // The whole point of F4: the backfill is NOT stuck at zero anymore.
    expect(backfillState?.itemsSynced ?? 0).toBeGreaterThan(0);
    expect(scheduler.status.activeLane).not.toBe('idle');
    // R4 is UNCHANGED by R8: per-lane health (used for /sync/status +
    // the F4 circuit breaker) still reflects the sustained delta failure.
    expect(scheduler.status.degraded).toBe(true);
    expect(scheduler.status.consecutiveFailures).toBeGreaterThan(0);
  });
});

/**
 * gr-receipt-annulment (design.md Testing strategy) — "Todo test del anulado
 * va acá, no en un unitario del mapper: el bug vivía justo en la juntura
 * parser↔mapper que un unitario no cruza." Raw payload -> REAL parser -> REAL
 * `SyncGrReceiptsReconcileWindow` -> in-memory repo, molde
 * `RawPayloadGestionRealPort` already defined above.
 */
function makeReconcileHarness(pageSize = 100, now: () => Date = () => new Date('2026-08-10T14:00:00Z')) {
  const gr = new RawPayloadGestionRealPort();
  const state = new InMemorySyncStateRepository();
  const receiptRepo = new InMemoryFinancePaymentReceiptRepository();
  const applicationRepo = new InMemoryFinanceReceiptApplicationRepository(receiptRepo);
  const invoiceTypes = new InMemoryFinanceInvoiceTypeClassificationRepository();
  const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
  const itemRepo = new InMemoryFinanceReceiptItemRepository(receiptRepo);
  const retencionRepo = new InMemoryFinanceReceiptRetencionRepository();
  const uc = new SyncGrReceiptsReconcileWindow(gr, state, receiptRepo, applicationRepo, invoiceTypes, syncConfig, itemRepo, retencionRepo, { pageSize, now });
  return { gr, state, receiptRepo, applicationRepo, invoiceTypes, syncConfig, itemRepo, retencionRepo, uc };
}

/** Builds a raw `recibos` payload with `totalCount` receipts, the first `residueCount` carrying an unparseable `fecha_anulacion` (financeAnnulmentGuard fodder), the rest the known-good sentinel. */
function buildResiduePayload(totalCount: number, residueCount: number, fechaDDMMYYYY: string) {
  const recibos: Record<string, unknown> = {};
  for (let i = 0; i < totalCount; i++) {
    recibos[`G${i}`] = {
      cliente: { cliente_id: '100099', nombre: 'CLIENTE DE PRUEBA' },
      recaudador: 'mercadopago',
      fecha_recibo: fechaDDMMYYYY,
      fecha_confirmacion: `${fechaDDMMYYYY} 10:00:00`,
      fecha_anulacion: i < residueCount ? 'basura' : '00-00-0000 00:00:00',
      observaciones: null,
      aplicaciones: { '1': { tipo: 'FB', sucursal: '00010', numero: `n${i}`, importe: '10.00', fecha: fechaDDMMYYYY } },
      items: { '1': { banco: null, caja_cuenta_id: null, destino: null, fecha: fechaDDMMYYYY, importe: '10.00', moneda: null, numero_transferencia: null, tipo: null } },
      retenciones: {},
    };
  }
  return { error: 0, resultados: String(totalCount), recibos };
}

describe('finance-receipts-ingest seam — SyncGrReceiptsReconcileWindow (S1-S5, raw payload -> REAL parser -> REAL use case -> in-memory repo)', () => {
  it('S1 — a payload with a REAL fecha_anulacion is INCLUDED (rows.size===1), marked anulado:true, with its children persisted (scenario 1)', async () => {
    const { gr, receiptRepo, applicationRepo, itemRepo, syncConfig, uc } = makeReconcileHarness();
    await syncConfig.update({ reconcileWindowDays: 35 });
    const payload = rawReciboPayload('9001', '100011', 1500, '05-08-2026');
    (payload.recibos['9001'] as Record<string, unknown>).fecha_anulacion = '06-08-2026 12:00:00';
    gr.rawResponses.push(payload);

    await uc.execute();

    // PRESENCE first, then the flag — a probe whose only assertion is an
    // absence gives false confidence against a world where the row never existed.
    expect(receiptRepo.rows.size).toBe(1);
    expect(receiptRepo.rows.get('9001')?.anulado).toBe(true);
    expect(applicationRepo.rows.size).toBeGreaterThan(0);
    expect(itemRepo.rows.size).toBeGreaterThan(0);
  });

  it('S2 — THE FLIP (la invariante del change): a healthy receipt from sweep 1 becomes anulado:true in sweep 2 when GR reports a real fecha_anulacion on the SAME grReceiptId (scenarios 1/27)', async () => {
    const now = { v: new Date('2026-08-10T14:00:00Z') };
    const { gr, receiptRepo, syncConfig, uc } = makeReconcileHarness(100, () => now.v);
    await syncConfig.update({ reconcileWindowDays: 35 });

    gr.rawResponses.push(rawReciboPayload('9002', '100022', 800, '05-08-2026'));
    await uc.execute();
    expect(receiptRepo.rows.get('9002')?.anulado).toBe(false);

    // Force a second sweep (default cadence 6h) — the SAME grReceiptId, now voided.
    now.v = new Date('2026-08-10T21:00:00Z');
    const voided = rawReciboPayload('9002', '100022', 800, '05-08-2026');
    (voided.recibos['9002'] as Record<string, unknown>).fecha_anulacion = '09-08-2026 10:00:00';
    gr.rawResponses.push(voided);
    await uc.execute();

    expect(receiptRepo.rows.size).toBe(1); // the SAME fila, not a duplicate
    expect(receiptRepo.rows.get('9002')?.anulado).toBe(true); // FLIPPED — exercises the upsert's `update` block
  });

  it('S3 — the inverse of S2: re-upserting an already-healthy receipt a second time stays anulado:false (no spurious flip)', async () => {
    const now = { v: new Date('2026-08-10T14:00:00Z') };
    const { gr, receiptRepo, syncConfig, uc } = makeReconcileHarness(100, () => now.v);
    await syncConfig.update({ reconcileWindowDays: 35 });

    gr.rawResponses.push(rawReciboPayload('9005', '100055', 400, '05-08-2026'));
    await uc.execute();

    now.v = new Date('2026-08-10T21:00:00Z');
    gr.rawResponses.push(rawReciboPayload('9005', '100055', 400, '05-08-2026'));
    await uc.execute();

    expect(receiptRepo.rows.size).toBe(1);
    expect(receiptRepo.rows.get('9005')?.anulado).toBe(false);
  });

  it('S4 — reconcile catches a receipt confirmed LATE (fecha_recibo 5 days old, ABSENT from the mirror before the sweep) — the bug measured in prod (scenario 13)', async () => {
    const { gr, receiptRepo, syncConfig, uc } = makeReconcileHarness();
    await syncConfig.update({ reconcileWindowDays: 35 });
    expect(receiptRepo.rows.has('9003')).toBe(false); // absent BEFORE — simulates the delta lane's overlap window having missed it
    gr.rawResponses.push(rawReciboPayload('9003', '100033', 500, '05-08-2026')); // 5 days before "now" (10-08)

    await uc.execute();

    expect(receiptRepo.rows.has('9003')).toBe(true);
    expect(receiptRepo.rows.get('9003')?.fechaRecibo?.toISOString()).toBe('2026-08-05T03:00:00.000Z');
  });

  // ── fix-wave RF12 — as written, this test was satisfied by a second sweep
  // that wrote NOTHING AT ALL (a lane that silently no-ops trivially "does not
  // duplicate rows"). Scenario 14 is about idempotence of a real re-write, so
  // the second sweep now carries an OBSERVABLY DIFFERENT payload: the
  // assertion is "the row was rewritten AND there is still exactly one".
  it('re-sweeping the same window twice REWRITES the same rows without duplicating them in any of the four tables (scenario 14)', async () => {
    const now = { v: new Date('2026-08-10T14:00:00Z') };
    const { gr, receiptRepo, applicationRepo, itemRepo, syncConfig, uc } = makeReconcileHarness(100, () => now.v);
    await syncConfig.update({ reconcileWindowDays: 35 });

    gr.rawResponses.push(rawReciboPayload('9004', '100044', 100, '05-08-2026'));
    await uc.execute();
    expect(receiptRepo.rows.get('9004')?.recaudador).toBe('mercadopago');

    now.v = new Date('2026-08-10T21:00:00Z');
    const second = rawReciboPayload('9004', '100044', 100, '05-08-2026');
    (second.recibos['9004'] as Record<string, unknown>).recaudador = 'rapipago'; // GR corrected the collector
    gr.rawResponses.push(second);
    const result = await uc.execute();

    // The second sweep ACTUALLY WROTE (this is what a no-op lane fails).
    expect(result.pageProcessed).toBe(1);
    expect(receiptRepo.rows.get('9004')?.recaudador).toBe('rapipago');
    // ...and wrote over the SAME rows.
    expect(receiptRepo.rows.size).toBe(1);
    expect(applicationRepo.rows.size).toBe(1);
    expect(itemRepo.rows.size).toBe(1);
  });

  // ── fix-wave RF1 — the inverse of S2, and the reason the flip is a LATCH.
  // GR blanking `fecha_anulacion` on a re-consulted receipt (format drift,
  // partial response) must NEVER de-annul the mirror: mass de-annulment is
  // indistinguishable from healthy data downstream, so nothing else in the
  // system could catch it.
  it('S2-latch — an already-annulled receipt reported HEALTHY on a later sweep stays anulado:true (no automatic un-annulment)', async () => {
    const now = { v: new Date('2026-08-10T14:00:00Z') };
    const { gr, receiptRepo, syncConfig, uc } = makeReconcileHarness(100, () => now.v);
    await syncConfig.update({ reconcileWindowDays: 35 });

    const voided = rawReciboPayload('9006', '100066', 700, '05-08-2026');
    (voided.recibos['9006'] as Record<string, unknown>).fecha_anulacion = '09-08-2026 10:00:00';
    gr.rawResponses.push(voided);
    await uc.execute();
    expect(receiptRepo.rows.get('9006')?.anulado).toBe(true);

    // Sweep 2: GR now reports the sentinel (no annulment) for the SAME receipt.
    now.v = new Date('2026-08-10T21:00:00Z');
    const healthyAgain = rawReciboPayload('9006', '100066', 700, '05-08-2026');
    (healthyAgain.recibos['9006'] as Record<string, unknown>).recaudador = 'rapipago';
    gr.rawResponses.push(healthyAgain);
    await uc.execute();

    // The rest of the row IS refreshed — the latch is scoped to `anulado`.
    expect(receiptRepo.rows.get('9006')?.recaudador).toBe('rapipago');
    expect(receiptRepo.rows.get('9006')?.anulado).toBe(true);
  });

  it('a GR error envelope during reconcile propagates as a thrown error — zero writes, cursor untouched (scenario 16, mismo criterio que delta/backfill)', async () => {
    const { gr, receiptRepo, state, syncConfig, uc } = makeReconcileHarness();
    await syncConfig.update({ reconcileWindowDays: 35 });
    gr.rawResponses.push({ error: '91', descripcion: 'No Se indicó la Acción' });

    await expect(uc.execute()).rejects.toThrow(/91/);

    expect(receiptRepo.rows.size).toBe(0);
    const saved = await state.get(RECONCILE_ENTITY);
    expect(saved?.lastResult).toMatch(/^error:/);
  });

  it('S5 — the systemic guard aborts a page with 63/100 residue: throws FinanceReceiptAnnulmentGuardError, ZERO writes, cursor untouched, lastResult starts with "error:" (scenarios 19/21)', async () => {
    const { gr, receiptRepo, applicationRepo, state, syncConfig, uc } = makeReconcileHarness();
    await syncConfig.update({ reconcileWindowDays: 35 });
    gr.rawResponses.push(buildResiduePayload(100, 63, '05-08-2026'));

    await expect(uc.execute()).rejects.toBeInstanceOf(FinanceReceiptAnnulmentGuardError);

    expect(receiptRepo.rows.size).toBe(0); // cero escrituras — el mismo repo que S1 demostró que sabe escribir
    expect(applicationRepo.rows.size).toBe(0);
    const saved = await state.get(RECONCILE_ENTITY);
    expect(saved?.lastResult).toMatch(/^error:/);
    expect(saved?.cursor).toBe('06-07-2026:09-08-2026:0'); // sin avanzar — la misma página se reintenta
  });
});

/**
 * gr-receipt-annulment (design.md Testing strategy, "S6") — the THREE real
 * use cases + the real scheduler, sharing ONE `GestionRealPort`, over ~40
 * ticks. Molde the F4 seam test above, extended to a third lane: delta gets
 * PERMANENTLY poisoned (persistence layer, GR itself healthy — same P2000
 * shape) so its every attempt fails, while reconcile and backfill share a
 * healthy responder. Verifies the full priority chain end to end: delta
 * always attempted first; reconcile takes the turns delta cedes; backfill
 * still progresses; the shared pacing backoff never escalates (GR was never
 * the problem, only the poisoned lane's persistence).
 */
class PoisonedApplicationRepoS6 extends InMemoryFinanceReceiptApplicationRepository {
  async upsertBatch(applications: FinanceReceiptApplication[]): Promise<void> {
    if (applications.some((a) => a.amount === 999999999)) {
      throw new Error('P2000: value too long for column importe');
    }
    return super.upsertBatch(applications);
  }
}

describe('finance-receipts-ingest seam — S6: THREE real use cases + REAL scheduler, delta permanently poisoned', () => {
  it('delta always attempted (and fails); reconcile takes the turns delta cedes; backfill keeps progressing; the shared backoff never escalates (F4 held across 3 lanes)', async () => {
    const gr = new RawPayloadGestionRealPort();
    let poisonCounter = 0;
    let okCounter = 0;
    gr.responder = (params) => {
      if (params.fechaDesde === params.fechaHasta) {
        // Delta's single-day request — ALWAYS poisoned.
        return rawReciboPayload(`poison-${poisonCounter++}`, '100099', 999999999, '15-07-2026');
      }
      // Backfill's whole-month AND reconcile's 35-day-window requests both
      // land here — a healthy receipt either way, unique ids never collide.
      return rawReciboPayload(`ok-${okCounter++}`, '100011', 1000, '10-07-2026');
    };

    const state = new InMemorySyncStateRepository();
    const receiptRepo = new InMemoryFinancePaymentReceiptRepository();
    const applicationRepo = new PoisonedApplicationRepoS6(receiptRepo);
    const invoiceTypes = new InMemoryFinanceInvoiceTypeClassificationRepository();
    const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
    await syncConfig.update({ backfillFloorYearMonth: '2026-01', reconcileWindowDays: 35, reconcileCheckIntervalMs: 21600000 });

    const now = () => new Date('2026-08-10T14:00:00Z');
    const itemRepo = new InMemoryFinanceReceiptItemRepository();
    const retencionRepo = new InMemoryFinanceReceiptRetencionRepository();
    const syncDelta = new SyncGrReceiptsDelta(gr, state, receiptRepo, applicationRepo, invoiceTypes, syncConfig, itemRepo, retencionRepo, { now });
    const syncBackfill = new SyncGrReceiptsBackfillBatch(gr, state, receiptRepo, applicationRepo, invoiceTypes, syncConfig, itemRepo, retencionRepo, { now });
    const syncReconcile = new SyncGrReceiptsReconcileWindow(gr, state, receiptRepo, applicationRepo, invoiceTypes, syncConfig, itemRepo, retencionRepo, { now });

    const lock = new InMemoryDistributedLock();
    const scheduler = new FinanceReceiptIngestScheduler(syncDelta, syncBackfill, state, lock, syncConfig, syncReconcile, { silent: true, now });

    const lanesSeen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const result = await scheduler.tick();
      if (result.lane) lanesSeen.add(result.lane);
      // The whole point of R8/Decision 4: a delta PERSISTENCE failure (GR is
      // healthy) must never escalate the SHARED request-pacing backoff,
      // whichever lane actually ran this tick.
      expect(scheduler.status.effectiveIntervalMs).toBe(FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS.requestIntervalMs);
    }

    const deltaState = await state.get(DELTA_ENTITY);
    const backfillState = await state.get(BACKFILL_ENTITY);
    const reconcileState = await state.get(RECONCILE_ENTITY);

    // Delta stays visibly broken — attempted every time it's due, never silently skipped.
    expect(deltaState?.lastResult).toMatch(/^error:/);
    // Reconcile and backfill BOTH made real progress across the 40 ticks —
    // delta's permanent failure never fully starves either of them.
    expect(reconcileState?.itemsSynced ?? 0).toBeGreaterThan(0);
    expect(backfillState?.itemsSynced ?? 0).toBeGreaterThan(0);
    // All three lanes actually held the turn at some point.
    expect(lanesSeen.has('reconcile')).toBe(true);
    expect(lanesSeen.has('backfill')).toBe(true);
    expect(scheduler.status.degraded).toBe(true); // delta's sustained failure is visible on /sync/status
  });

  // ── task 8.10's actual kill target — the FIRST S6 test above never
  // exercises this: with `total=1` on every raw payload, reconcile's own
  // sweep CLOSES after one page regardless of F4, so it only ever "steals"
  // ONE tick out of 40 no matter what — the F4-for-reconcile mirror (design.md
  // Decision 1) is invisible to that fixture. THIS test poisons reconcile's
  // OWN persistence (delta stays healthy-and-quiet) so reconcile's cursor
  // never advances and it stays PERMANENTLY "due" — the exact condition
  // under which F4's alternation actually matters. Distinguishes reconcile
  // from backfill by request shape: backfill always starts a month range at
  // "01-", reconcile's 35-day window (fixed `now`) never does.
  it('reconcile permanently poisoned (persistence) and permanently "due" still cedes turns to backfill via its OWN F4 mirror — backfill is never starved', async () => {
    const gr = new RawPayloadGestionRealPort();
    let okDeltaCounter = 0;
    let okBackfillCounter = 0;
    let poisonReconcileCounter = 0;
    gr.responder = (params) => {
      if (params.fechaDesde === params.fechaHasta) {
        return rawReciboPayload(`ok-delta-${okDeltaCounter++}`, '100011', 1000, '10-08-2026');
      }
      if (params.fechaDesde.startsWith('01-')) {
        return rawReciboPayload(`ok-backfill-${okBackfillCounter++}`, '100022', 1000, '10-07-2026');
      }
      // Reconcile's 35-day window — permanently poisoned.
      return rawReciboPayload(`poison-reconcile-${poisonReconcileCounter++}`, '100099', 999999999, '20-07-2026');
    };

    const state = new InMemorySyncStateRepository();
    const receiptRepo = new InMemoryFinancePaymentReceiptRepository();
    const applicationRepo = new PoisonedApplicationRepoS6(receiptRepo);
    const invoiceTypes = new InMemoryFinanceInvoiceTypeClassificationRepository();
    const syncConfig = new InMemoryFinanceReceiptSyncConfigRepository();
    await syncConfig.update({ backfillFloorYearMonth: '2026-01', reconcileWindowDays: 35, reconcileCheckIntervalMs: 21600000, deltaCheckIntervalMs: 300000 });

    const now = () => new Date('2026-08-10T14:00:00Z');
    const itemRepo = new InMemoryFinanceReceiptItemRepository();
    const retencionRepo = new InMemoryFinanceReceiptRetencionRepository();
    const syncDelta = new SyncGrReceiptsDelta(gr, state, receiptRepo, applicationRepo, invoiceTypes, syncConfig, itemRepo, retencionRepo, { now });
    const syncBackfill = new SyncGrReceiptsBackfillBatch(gr, state, receiptRepo, applicationRepo, invoiceTypes, syncConfig, itemRepo, retencionRepo, { now });
    const syncReconcile = new SyncGrReceiptsReconcileWindow(gr, state, receiptRepo, applicationRepo, invoiceTypes, syncConfig, itemRepo, retencionRepo, { now });

    const lock = new InMemoryDistributedLock();
    const scheduler = new FinanceReceiptIngestScheduler(syncDelta, syncBackfill, state, lock, syncConfig, syncReconcile, { silent: true, now });

    // Prime delta so it becomes NOT due quickly (one healthy "today" run),
    // letting reconcile and backfill compete for the rest of the ticks.
    await scheduler.tick();

    for (let i = 0; i < 40; i++) {
      await scheduler.tick();
    }

    const backfillState = await state.get(BACKFILL_ENTITY);
    const reconcileState = await state.get(RECONCILE_ENTITY);

    // Reconcile stays visibly, permanently broken — never silently skipped.
    expect(reconcileState?.lastResult).toMatch(/^error:/);
    // The whole point of F4-for-reconcile: backfill is NOT stuck at zero,
    // even though reconcile is ALWAYS "due" (its cursor never advances).
    expect(backfillState?.itemsSynced ?? 0).toBeGreaterThan(0);
  });
});
