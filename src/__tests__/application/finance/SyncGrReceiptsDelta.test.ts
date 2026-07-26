import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryFinancePaymentReceiptRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePaymentReceiptRepository';
import { InMemoryFinanceReceiptApplicationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptApplicationRepository';
import { InMemoryFinanceInvoiceTypeClassificationRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceInvoiceTypeClassificationRepository';
import { InMemoryFinanceReceiptItemRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptItemRepository';
import { InMemoryFinanceReceiptRetencionRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptRetencionRepository';
import { SyncGrReceiptsDelta } from '@application/use-cases/finance/SyncGrReceiptsDelta';
import { FinanceReceiptPersistenceError } from '@application/use-cases/finance/financeIngestErrors';
import { GrReceipt } from '@domain/entities/gestionReal';

const ENTITY = 'finance-receipts-delta';

function receipt(id: string, dateDDMMYYYY: string): GrReceipt {
  return {
    grReceiptId: id,
    clienteGrId: '100011',
    recaudador: 'mercadopago',
    fechaRecibo: `${dateDDMMYYYY} 10:00:00`,
    fechaConfirmacion: null,
    fechaAnulacion: null,
    observaciones: null,
    applications: [
      { grApplicationId: `${id}-a1`, tipo: 'FB', sucursal: '00010', numero: id, importe: 1000, fecha: dateDDMMYYYY },
    ],
  };
}

function makeHarness(pageSize: number, now: () => Date) {
  const gr = new InMemoryGestionRealPort();
  const state = new InMemorySyncStateRepository();
  const receipts = new InMemoryFinancePaymentReceiptRepository();
  const applications = new InMemoryFinanceReceiptApplicationRepository(receipts);
  const invoiceTypes = new InMemoryFinanceInvoiceTypeClassificationRepository();
  const items = new InMemoryFinanceReceiptItemRepository();
  const retenciones = new InMemoryFinanceReceiptRetencionRepository();
  const uc = new SyncGrReceiptsDelta(gr, state, receipts, applications, invoiceTypes, items, retenciones, { pageSize, now });
  return { gr, state, receipts, applications, invoiceTypes, items, retenciones, uc };
}

describe('SyncGrReceiptsDelta', () => {
  // ── fix-wave-3 R9 — the money-path footgun: fix-wave-2 made itemRepo/
  // retencionRepo optional-and-trailing so `if (this.itemRepo) ...` could
  // skip SILENTLY (tsc green, no test failing, cash metric zeroing out).
  // The constructor now throws if either is missing — this is the ONLY test
  // in the suite that deliberately bypasses TypeScript (via `as never`) to
  // exercise that runtime guard for a caller that constructs this with a
  // `null`/`undefined` collaborator despite the type system saying otherwise
  // (e.g. a bad conditional in a future refactor of the composition root).
  describe('R9: itemRepo/retencionRepo are MANDATORY — construction throws if either is missing', () => {
    it('throws when itemRepo is missing', () => {
      expect(() => new SyncGrReceiptsDelta(
        new InMemoryGestionRealPort(),
        new InMemorySyncStateRepository(),
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        undefined as never,
        new InMemoryFinanceReceiptRetencionRepository(),
      )).toThrow(/itemRepo and retencionRepo are REQUIRED/);
    });

    it('throws when retencionRepo is missing', () => {
      expect(() => new SyncGrReceiptsDelta(
        new InMemoryGestionRealPort(),
        new InMemorySyncStateRepository(),
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        undefined as never,
      )).toThrow(/itemRepo and retencionRepo are REQUIRED/);
    });

    it('does NOT throw when both are provided', () => {
      expect(() => new SyncGrReceiptsDelta(
        new InMemoryGestionRealPort(),
        new InMemorySyncStateRepository(),
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
      )).not.toThrow();
    });
  });

  it('first run (no cursor) syncs ONLY today, offset 0 — no historical backfill', async () => {
    const now = () => new Date('2026-07-15T14:00:00Z');
    const { gr, uc } = makeHarness(100, now);
    gr.receipts.push(receipt('R1', '15-07-2026'));

    await uc.execute();

    expect(gr.receiptsCalls).toHaveLength(1);
    expect(gr.receiptsCalls[0]).toMatchObject({ fechaDesde: '15-07-2026', fechaHasta: '15-07-2026', offset: 0 });
  });

  it('pages EXACTLY one page; a remaining range persists the COMPOSITE cursor', async () => {
    const now = () => new Date('2026-07-15T14:00:00Z');
    const { gr, state, uc } = makeHarness(2, now);
    gr.receipts.push(receipt('R1', '15-07-2026'), receipt('R2', '15-07-2026'), receipt('R3', '15-07-2026'));

    const result = await uc.execute();

    expect(gr.receiptsCalls).toHaveLength(1);
    expect(result.hasPendingPages).toBe(true);
    const saved = await state.get(ENTITY);
    expect(saved?.cursor).toBe('15-07-2026:15-07-2026:2');
  });

  it('once the whole range is paged, the cursor COLLAPSES to the plain fechaHasta', async () => {
    const now = () => new Date('2026-07-15T14:00:00Z');
    const { gr, state, uc } = makeHarness(100, now);
    gr.receipts.push(receipt('R1', '15-07-2026'));

    const result = await uc.execute();

    expect(result.hasPendingPages).toBe(false);
    const saved = await state.get(ENTITY);
    expect(saved?.cursor).toBe('15-07-2026');
  });

  it('a subsequent run reads the plain cursor as the new fechaDesde (overlap of >=1 day)', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: ENTITY, cursor: '14-07-2026', lastRunAt: null, lastResult: 'ok', itemsSynced: 1 });
    const gr = new InMemoryGestionRealPort();
    gr.receipts.push(receipt('R2', '15-07-2026'));
    const uc = new SyncGrReceiptsDelta(
      gr, state,
      new InMemoryFinancePaymentReceiptRepository(),
      new InMemoryFinanceReceiptApplicationRepository(),
      new InMemoryFinanceInvoiceTypeClassificationRepository(),
      new InMemoryFinanceReceiptItemRepository(),
      new InMemoryFinanceReceiptRetencionRepository(),
      { pageSize: 100, now: () => new Date('2026-07-15T14:00:00Z') },
    );

    await uc.execute();

    expect(gr.receiptsCalls[0]).toMatchObject({ fechaDesde: '14-07-2026', fechaHasta: '15-07-2026' });
  });

  it('resumes an in-progress composite cursor at the SAME range/offset', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: ENTITY, cursor: '10-07-2026:15-07-2026:4', lastRunAt: null, lastResult: 'page ok', itemsSynced: 4 });
    const gr = new InMemoryGestionRealPort();
    for (let i = 0; i < 6; i++) gr.receipts.push(receipt(`R${i}`, '12-07-2026'));
    const uc = new SyncGrReceiptsDelta(
      gr, state,
      new InMemoryFinancePaymentReceiptRepository(),
      new InMemoryFinanceReceiptApplicationRepository(),
      new InMemoryFinanceInvoiceTypeClassificationRepository(),
      new InMemoryFinanceReceiptItemRepository(),
      new InMemoryFinanceReceiptRetencionRepository(),
      { pageSize: 2, now: () => new Date('2026-07-15T14:00:00Z') },
    );

    await uc.execute();

    expect(gr.receiptsCalls[0]).toMatchObject({ fechaDesde: '10-07-2026', fechaHasta: '15-07-2026', offset: 4 });
  });

  it('idempotent upsert: running twice over overlapping data does not duplicate rows', async () => {
    const now = () => new Date('2026-07-15T14:00:00Z');
    const { gr, receipts, applications, uc } = makeHarness(100, now);
    gr.receipts.push(receipt('R1', '15-07-2026'));

    await uc.execute();
    await uc.execute(); // second tick, same "today" — overlap re-fetches the same receipt

    expect(receipts.rows.size).toBe(1);
    expect(applications.rows.size).toBe(1);
  });

  it('auto-classifies an unseen grType', async () => {
    const now = () => new Date('2026-07-15T14:00:00Z');
    const { gr, invoiceTypes, uc } = makeHarness(100, now);
    const r = receipt('R1', '15-07-2026');
    r.applications[0]!.tipo = 'FX';
    gr.receipts.push(r);

    await uc.execute();

    const fx = await invoiceTypes.get('FX');
    expect(fx?.bucket).toBe('unclassified');
  });

  // ── F5 — a PERSISTENCE failure (not just a GR-fetch failure) must ALSO be
  // recorded in SyncState with `lastResult: error:` — before the fix, only
  // `gr.fetchReceipts` was wrapped; a throw from `receiptRepo.upsertBatch`/
  // `applicationRepo.upsertBatch`/`invoiceTypes.upsertIfAbsent` escaped
  // `execute()` UNCAUGHT, so SyncState was never touched at all and
  // `/sync/status` kept reporting the stale `lastResult: 'ok'` forever.
  describe('F5: persistence failures are recorded, not swallowed', () => {
    it('receiptRepo.upsertBatch throwing still records lastResult: error: and rethrows', async () => {
      const now = () => new Date('2026-07-15T14:00:00Z');
      const gr = new InMemoryGestionRealPort();
      gr.receipts.push(receipt('R1', '15-07-2026'));
      const state = new InMemorySyncStateRepository();
      const receipts = new InMemoryFinancePaymentReceiptRepository();
      receipts.upsertBatch = async () => {
        throw new Error('P2000: value too long for column importe');
      };
      const uc = new SyncGrReceiptsDelta(
        gr, state, receipts,
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 100, now },
      );

      await expect(uc.execute()).rejects.toThrow('P2000');

      const saved = await state.get(ENTITY);
      expect(saved?.lastResult).toMatch(/^error:/);
      expect(saved?.lastRunAt).not.toBeNull();
    });

    it('applicationRepo.upsertBatch throwing ALSO records lastResult: error: (not just fetch failures)', async () => {
      const now = () => new Date('2026-07-15T14:00:00Z');
      const gr = new InMemoryGestionRealPort();
      gr.receipts.push(receipt('R1', '15-07-2026'));
      const state = new InMemorySyncStateRepository();
      const applications = new InMemoryFinanceReceiptApplicationRepository();
      applications.upsertBatch = async () => {
        throw new Error('P2000: poisoned row');
      };
      const uc = new SyncGrReceiptsDelta(
        gr, state,
        new InMemoryFinancePaymentReceiptRepository(),
        applications,
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 100, now },
      );

      await expect(uc.execute()).rejects.toThrow('poisoned row');

      const saved = await state.get(ENTITY);
      expect(saved?.lastResult).toMatch(/^error: .*poisoned row/);
    });

    // ── fix-wave-3 R8 — a PERSISTENCE failure must be tagged as such (never
    // as a GR-fetch failure) so the scheduler's shared pacing backoff doesn't
    // degrade the whole request rhythm over a poisoned row while GR itself is
    // fine. See `FinanceReceiptIngestScheduler.test.ts` "R8" for the pacing
    // assertion — this only pins the ERROR SHAPE `execute()` throws.
    it('a persistence failure is thrown as FinanceReceiptPersistenceError, wrapping the original message', async () => {
      const now = () => new Date('2026-07-15T14:00:00Z');
      const gr = new InMemoryGestionRealPort();
      gr.receipts.push(receipt('R1', '15-07-2026'));
      const applications = new InMemoryFinanceReceiptApplicationRepository();
      applications.upsertBatch = async () => {
        throw new Error('P2000: poisoned row');
      };
      const uc = new SyncGrReceiptsDelta(
        gr, new InMemorySyncStateRepository(),
        new InMemoryFinancePaymentReceiptRepository(),
        applications,
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 100, now },
      );

      await expect(uc.execute()).rejects.toBeInstanceOf(FinanceReceiptPersistenceError);
      await expect(uc.execute()).rejects.toThrow('poisoned row');
    });

    it('a GR-fetch failure is NEVER wrapped as FinanceReceiptPersistenceError', async () => {
      const now = () => new Date('2026-07-15T14:00:00Z');
      const gr = new InMemoryGestionRealPort();
      gr.fetchReceipts = async () => {
        throw new Error('GR timeout');
      };
      const uc = new SyncGrReceiptsDelta(
        gr, new InMemorySyncStateRepository(),
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 100, now },
      );

      await expect(uc.execute()).rejects.not.toBeInstanceOf(FinanceReceiptPersistenceError);
      await expect(uc.execute()).rejects.toThrow('GR timeout');
    });
  });

  // ── F12 — a page requested within the reported range that parses to ZERO
  // receipts is suspicious (F1/F2-style silent field-mapping regressions
  // wouldn't otherwise show any signal — itemsSynced keeps climbing and
  // lastResult stays 'ok'). Guard must be `offset < total`, NOT `total > 0`:
  // a legitimate empty TAIL page (measured: offset=900, total=828) must NOT warn.
  describe('F12: suspicious empty-page warning', () => {
    it('warns when offset < total but the page parsed to zero receipts', async () => {
      const now = () => new Date('2026-07-15T14:00:00Z');
      const gr = new InMemoryGestionRealPort();
      gr.fetchReceipts = async () => ({ total: 5, receipts: [] });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const uc = new SyncGrReceiptsDelta(
        gr, new InMemorySyncStateRepository(),
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 100, now },
      );

      await uc.execute();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/suspicious empty page/i));
      warnSpy.mockRestore();
    });

    it('does NOT warn for a legitimate empty TAIL page (offset >= total)', async () => {
      const now = () => new Date('2026-07-15T14:00:00Z');
      const gr = new InMemoryGestionRealPort();
      gr.fetchReceipts = async () => ({ total: 0, receipts: [] });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const uc = new SyncGrReceiptsDelta(
        gr, new InMemorySyncStateRepository(),
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 100, now },
      );

      await uc.execute();

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ── F14 — a corrupted composite/plain cursor must never be blindly trusted;
  // the use case resets to a sane state (today) instead of deriving garbage
  // (e.g. an invalid GR date) and re-persisting it forever.
  describe('F14: corrupt cursor recovery', () => {
    it('a malformed composite cursor (missing parts) resets to scanning today, not a garbage range', async () => {
      const now = () => new Date('2026-07-15T14:00:00Z');
      const state = new InMemorySyncStateRepository();
      await state.save({ entity: ENTITY, cursor: '10-07-2026:garbage', lastRunAt: null, lastResult: 'page ok', itemsSynced: 4 });
      const gr = new InMemoryGestionRealPort();
      gr.receipts.push(receipt('R1', '15-07-2026'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const uc = new SyncGrReceiptsDelta(
        gr, state,
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 100, now },
      );

      await uc.execute();

      expect(gr.receiptsCalls[0]).toMatchObject({ fechaDesde: '15-07-2026', fechaHasta: '15-07-2026', offset: 0 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/corrupt/i));
      warnSpy.mockRestore();
    });

    it('a malformed plain cursor (not a DD-MM-AAAA date) resets to scanning today', async () => {
      const now = () => new Date('2026-07-15T14:00:00Z');
      const state = new InMemorySyncStateRepository();
      await state.save({ entity: ENTITY, cursor: '2026-07-14', lastRunAt: null, lastResult: 'ok', itemsSynced: 4 });
      const gr = new InMemoryGestionRealPort();
      gr.receipts.push(receipt('R1', '15-07-2026'));
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const uc = new SyncGrReceiptsDelta(
        gr, state,
        new InMemoryFinancePaymentReceiptRepository(),
        new InMemoryFinanceReceiptApplicationRepository(),
        new InMemoryFinanceInvoiceTypeClassificationRepository(),
        new InMemoryFinanceReceiptItemRepository(),
        new InMemoryFinanceReceiptRetencionRepository(),
        { pageSize: 100, now },
      );

      await uc.execute();

      expect(gr.receiptsCalls[0]).toMatchObject({ fechaDesde: '15-07-2026', fechaHasta: '15-07-2026', offset: 0 });
      warnSpy.mockRestore();
    });
  });
});
