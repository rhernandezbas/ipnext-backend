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
    await syncConfig.update({ backfillFloorYearMonth: '2026-01' });

    const now = () => new Date('2026-07-15T14:00:00Z');
    const itemRepo = new InMemoryFinanceReceiptItemRepository();
    const retencionRepo = new InMemoryFinanceReceiptRetencionRepository();
    const syncDelta = new SyncGrReceiptsDelta(gr, state, receiptRepo, applicationRepo, invoiceTypes, itemRepo, retencionRepo, { now });
    const syncBackfill = new SyncGrReceiptsBackfillBatch(gr, state, receiptRepo, applicationRepo, invoiceTypes, syncConfig, itemRepo, retencionRepo, { now });

    const lock = new InMemoryDistributedLock();
    const scheduler = new FinanceReceiptIngestScheduler(syncDelta, syncBackfill, state, lock, syncConfig, { silent: true, now });

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
