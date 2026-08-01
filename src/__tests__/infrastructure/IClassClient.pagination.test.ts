/**
 * Tests for the `fetchAllPages` pagination fix.
 *
 * ROOT CAUSE (see BACKLOG.md): the old code cut on
 * `if (!body.hasMoreElements || objects.length === 0) break;`, but IClass NEVER
 * returns `hasMoreElements` — so `!undefined === true` broke after page 1 on
 * EVERY call, silently. Measured impact: SyncIClassStatuses saw ~13% of the OS
 * in its 28-day window.
 *
 * FIX: paginate while the page comes back FULL (strict mode) and cut on the
 * first incomplete/empty/204 page — except /teams/{id}/locations, which is
 * proven (live, 59% point loss) to have short-but-not-last pages and needs an
 * 'empty-run' mode (2 consecutive zero-item pages) instead. That endpoint
 * already paginates on its own (`listTeamLocations`) rather than through
 * `fetchAllPages`; this suite covers only the methods that DO go through it.
 *
 * Call sites of `fetchAllPages` (all 'strict' — see IClassClient.ts for the
 * per-site justification):
 *   1. listServiceOrders            → /serviceorders
 *   2. getServiceOrderHistory       → /serviceorders/{id}/history
 *   3. getServiceOrderChecklists    → /serviceorders/{id}/checklist
 *   4. getServiceOrderMaterials     → /serviceorders/{id}/materials
 *   5. getServiceOrderEquipmentEvents → /serviceorders/{id}/equipments/history
 *   6. listResultCodes (discovery)  → /serviceorders
 *   7. listResultCodes (per soType) → /serviceordertypes/{id}/resultcodes
 */
import { IClassClient } from '@infrastructure/adapters/iclass/IClassClient';
import { IClassUnavailableError } from '@domain/errors/iclass';

const OPTS = {
  baseUrl: 'http://test',
  username: 'u',
  password: 'p',
  thirdPartyId: 'tp1',
  subresourceBackoffMs: 0,
  _sleep: async () => {},
};

/** Scripted GET queue (FIFO). Throws if the code tries to fetch more pages
 * than were scripted — that's how an over-fetch (or an under-cut leaving a
 * page unread) shows up as a test failure instead of silently passing. */
function scriptedGet(queue: Array<() => unknown>) {
  return jest.fn(() => {
    const next = queue.shift();
    if (!next) throw new Error('No more scripted GET responses — fetchAllPages requested an unexpected page');
    const result = next();
    return result instanceof Error ? Promise.reject(result) : Promise.resolve({ data: result });
  });
}

function makeClient(getQueue: Array<() => unknown>) {
  const http = { post: jest.fn(), get: scriptedGet(getQueue) };
  const client = new IClassClient({ ...OPTS, http: http as any });
  (client as any).token = 'TKN'; // skip login — not under test here
  return { client, http };
}

function rateLimitedBody() {
  return 'Espere um pouco, aguarde...';
}

// Minimal fixtures — every parser here (parseServiceOrderSummary, parseHistoryEntry,
// etc.) tolerates missing nested objects via obj()/strOrNull()/numOrNull(), so these
// only carry the fields each test actually asserts on.

function soObjects(count: number, startId: number, tipoOsId?: string) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(startId + i),
    codigo: String(startId + i),
    tipoOs: tipoOsId ? { id: tipoOsId } : {},
  }));
}

function historyObjects(count: number, startId: number) {
  return Array.from({ length: count }, (_, i) => ({ osStatusId: String(startId + i) }));
}

function checklistObjects(count: number, startId: number) {
  return Array.from({ length: count }, (_, i) => ({ pesquisaId: String(startId + i), perguntas: [] }));
}

function materialObjects(count: number, startId: number) {
  return Array.from({ length: count }, (_, i) => ({ id: String(startId + i) }));
}

function equipmentObjects(count: number) {
  return Array.from({ length: count }, () => ({ tipo: 'INSTALADO' }));
}

function resultCodeObjects(prefix: string, count: number, startId: number) {
  return Array.from({ length: count }, (_, i) => ({ codigo: `${prefix}-C${startId + i}`, tipo: 'x' }));
}

describe('IClassClient — fetchAllPages pagination fix', () => {
  const begin = new Date('2026-07-01T00:00:00Z');
  const end = new Date('2026-07-28T00:00:00Z');

  // ── Call site 1: listServiceOrders ────────────────────────────────────────
  // This is also the REVERT PROBE: against the old
  // `if (!body.hasMoreElements || objects.length === 0) break;` code,
  // `hasMoreElements` is never present in the fixtures below (IClass never
  // sends it), so `!undefined` is always true and this test returns only the
  // 60 items of page 1 instead of 190 — it must fail on that old code.
  it('1: listServiceOrders — 3 full pages (60) + 1 short page (10) ⇒ returns ALL 190, not just page 1', async () => {
    const { client, http } = makeClient([
      () => ({ objects: soObjects(60, 1) }),
      () => ({ objects: soObjects(60, 61) }),
      () => ({ objects: soObjects(60, 121) }),
      () => ({ objects: soObjects(10, 181) }),
    ]);

    const summaries = await client.listServiceOrders({ updatedDateBegin: begin, updatedDateEnd: end });

    expect(summaries).toHaveLength(190);
    expect(summaries[0].iclassCodigo).toBe('1');
    expect(summaries[189].iclassCodigo).toBe('190');
    expect(http.get).toHaveBeenCalledTimes(4);
    const pageNumbers = (http.get.mock.calls as unknown[][]).map(([url]) => new URL(String(url), 'http://x').searchParams.get('pagenumber'));
    expect(pageNumbers).toEqual(['1', '2', '3', '4']);
  });

  // ── Call site 2: getServiceOrderHistory ───────────────────────────────────
  it('2: getServiceOrderHistory — full page (60) + short page (20) ⇒ returns all 80, exactly 2 GETs', async () => {
    const { client, http } = makeClient([
      () => ({ objects: historyObjects(60, 1) }),
      () => ({ objects: historyObjects(20, 61) }),
    ]);

    const history = await client.getServiceOrderHistory('OS-1');

    expect(history).toHaveLength(80);
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  // ── Call site 3: getServiceOrderChecklists ────────────────────────────────
  it('3: getServiceOrderChecklists — full page (60) + short page (10) ⇒ returns all 70, exactly 2 GETs', async () => {
    const { client, http } = makeClient([
      () => ({ objects: checklistObjects(60, 1) }),
      () => ({ objects: checklistObjects(10, 61) }),
    ]);

    const checklists = await client.getServiceOrderChecklists('OS-1');

    expect(checklists).toHaveLength(70);
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  // ── Call site 4: getServiceOrderMaterials ─────────────────────────────────
  it('4: getServiceOrderMaterials — full page (60) + short page (15) ⇒ returns all 75, exactly 2 GETs', async () => {
    const { client, http } = makeClient([
      () => ({ objects: materialObjects(60, 1) }),
      () => ({ objects: materialObjects(15, 61) }),
    ]);

    const materials = await client.getServiceOrderMaterials('OS-1');

    expect(materials).toHaveLength(75);
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  // ── Call site 5: getServiceOrderEquipmentEvents ───────────────────────────
  it('5: getServiceOrderEquipmentEvents — full page (60) + short page (5) ⇒ returns all 65, exactly 2 GETs', async () => {
    const { client, http } = makeClient([
      () => ({ objects: equipmentObjects(60) }),
      () => ({ objects: equipmentObjects(5) }),
    ]);

    const events = await client.getServiceOrderEquipmentEvents('OS-1');

    expect(events).toHaveLength(65);
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  // ── Call sites 6+7: listResultCodes (discovery over /serviceorders, then
  //    fan-out to /serviceordertypes/{id}/resultcodes per discovered soType) ──
  // Only reachable together through the one public method. The discovery step
  // must read page 2 to ever learn soType 'T2' exists (page 1 is 100% 'T1');
  // the per-type fetch for 'T1' must read its own page 2 to see code C105.
  // If either fetchAllPages call under-cuts, this test catches it via a
  // missing type or a missing code.
  it('6+7: listResultCodes — discovery AND per-soType resultcodes both paginate past page 1', async () => {
    const { client, http } = makeClient([
      () => ({ objects: soObjects(60, 1, 'T1') }), // discovery p1: all T1
      () => ({ objects: soObjects(5, 61, 'T2') }), // discovery p2 (short, cuts): reveals T2
      () => ({ objects: resultCodeObjects('T1', 100, 1) }), // T1 resultcodes p1 (full)
      () => ({ objects: resultCodeObjects('T1', 5, 101) }), // T1 resultcodes p2 (short, cuts)
      () => ({ objects: resultCodeObjects('T2', 3, 1) }), // T2 resultcodes p1 (short, cuts)
    ]);

    const codes = await client.listResultCodes();

    // T1: 105 codes (100 + 5), T2: 3 codes = 108 total
    expect(codes).toHaveLength(108);
    expect(codes.some(c => c.soTypeId === 'T1' && c.code === 'T1-C105')).toBe(true); // only on T1's page 2
    expect(codes.some(c => c.soTypeId === 'T2' && c.code === 'T2-C3')).toBe(true); // only reachable if discovery read page 2
    expect(http.get).toHaveBeenCalledTimes(5);
  });

  // ── Shared guard: 204 / empty body ends pagination without throwing ──────
  it('8: 204 / empty body on the first page ⇒ returns empty list, no throw', async () => {
    const { client } = makeClient([() => null]); // axios .data === null on a 204

    const materials = await client.getServiceOrderMaterials('OS-empty');

    expect(materials).toEqual([]);
  });

  // ── Shared guard: persistent rate-limit still throws (regression) ────────
  it('9: persistent "Espere um pouco" rate-limit ⇒ still throws IClassUnavailableError (regression)', async () => {
    const { client, http } = makeClient([
      () => rateLimitedBody(), // first attempt
      () => rateLimitedBody(), // retry — still rate-limited
    ]);

    await expect(client.getServiceOrderHistory('OS-1')).rejects.toBeInstanceOf(IClassUnavailableError);
    expect(http.get).toHaveBeenCalledTimes(2); // 1 attempt + 1 retry, no further loop
  });

  // ── Guard: hard cap on pages, logged ───────────────────────────────────────
  it('10: an endpoint whose pages are ALWAYS full hits the page cap, cuts, and logs a warning', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const http = {
      post: jest.fn(),
      // Always returns a full page (60 items) — never short, never empty —
      // so 'strict' never finds a natural stopping point on its own.
      get: jest.fn(() => Promise.resolve({ data: { objects: materialObjects(60, 1) } })),
    };
    const client = new IClassClient({ ...OPTS, http: http as any });
    (client as any).token = 'TKN';

    const materials = await client.getServiceOrderMaterials('OS-endless');

    expect(http.get).toHaveBeenCalledTimes(200); // FETCH_ALL_PAGES_MAX_PAGES
    expect(materials).toHaveLength(200 * 60);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, meta] = warnSpy.mock.calls[0];
    expect(String(msg)).toContain('tope de 200');
    expect(String(msg)).toContain('/serviceorders/OS-endless/materials');
    expect(meta).toMatchObject({ itemsCollected: 200 * 60 });

    warnSpy.mockRestore();
  });

  // ── Extensibility: 'empty-run' strategy (mirrors listTeamLocations, unused
  //    by any current call site but exercised directly so a future caller
  //    that needs it — like a hypothetical migration of /teams/{id}/locations
  //    onto fetchAllPages — has proven behavior to rely on). ──────────────────
  describe("'empty-run' strategy (direct, private-method access — same pattern as (client as any).token elsewhere in this suite)", () => {
    it("11: two consecutive short-but-nonzero pages do NOT stop pagination (the /teams/{id}/locations anomaly) — only 2 consecutive EMPTY pages do", async () => {
      const { client, http } = makeClient([
        () => ({ objects: materialObjects(3, 1) }), // short — would stop 'strict', must NOT stop 'empty-run'
        () => ({ objects: materialObjects(2, 4) }), // short again — still must NOT stop
        () => ({ objects: [] }), // empty #1 — does not stop yet
        () => ({ objects: [] }), // empty #2 — stops
      ]);

      const params = new URLSearchParams({ pagesize: '60' });
      const out = await (client as any).fetchAllPages('/x', params, { strategy: 'empty-run' });

      expect(out).toHaveLength(5); // 3 + 2 from the two short pages; the empty pages add nothing
      expect(http.get).toHaveBeenCalledTimes(4);
    });

    it('12: the empty-page counter is CONSECUTIVE — a non-empty page in between resets it', async () => {
      const { client, http } = makeClient([
        () => ({ objects: [] }), // empty #1
        () => ({ objects: materialObjects(4, 1) }), // non-empty — resets the counter to 0
        () => ({ objects: [] }), // empty #1 again (not #2 — a naive cumulative counter would stop here)
        () => ({ objects: [] }), // empty #2 consecutive — stops
      ]);

      const params = new URLSearchParams({ pagesize: '60' });
      const out = await (client as any).fetchAllPages('/x', params, { strategy: 'empty-run' });

      expect(out).toHaveLength(4);
      expect(http.get).toHaveBeenCalledTimes(4);
    });
  });
});
