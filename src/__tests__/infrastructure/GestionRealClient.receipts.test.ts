import { parseReceiptsResponse } from '@infrastructure/adapters/gestion-real/GestionRealClient';

// REAL measured shape (fix-wave-1, 2026-07-26 — F1/F2). The ORIGINAL fixture here
// used `fecha`/root-level `cliente_id`, the SAME wrong assumption the production
// parser made — fixture and code shook hands on the same bug and both passed.
// Ground truth, measured 100/100 live recibos against the real GR API:
//   - the receipt date field is `fecha_recibo`, NOT `fecha` (F1).
//   - the client id lives NESTED at `cliente.cliente_id`, NEVER at the receipt
//     root as `cliente_id` (F2).
const RECIBOS_DICT_ROOT_DICT_APLICACIONES = {
  error: 0,
  resultados: '2',
  recibos: {
    '9001': {
      cliente: { cliente_id: '100011', nombre: 'ACOSTA JUAN' },
      recaudador: 'mercadopago',
      fecha_recibo: '15-06-2026 10:00:00',
      fecha_confirmacion: '15-06-2026 10:05:00',
      fecha_anulacion: '00-00-0000 00:00:00',
      observaciones: null,
      items: { '1': { medio: 'mercadopago', importe: 1500 } },
      aplicaciones: {
        '1': { tipo: 'FB', sucursal: '00010', numero: '000074035', importe: 1500, fecha: '15-06-2026' },
      },
    },
    '9002': {
      cliente: { cliente_id: '100012', nombre: 'PEREZ ANA' },
      recaudador: 'manual',
      fecha_recibo: '16-06-2026 11:00:00',
      fecha_confirmacion: null,
      fecha_anulacion: '00-00-0000 00:00:00',
      observaciones: 'pago parcial',
      items: { '1': { medio: 'efectivo', importe: 1000 } },
      aplicaciones: {
        '1': { tipo: 'FB', sucursal: '00010', numero: '000074036', importe: 800, fecha: '16-06-2026' },
        '2': { tipo: 'FA', sucursal: '00010', numero: '000000012', importe: 200, fecha: '16-06-2026' },
      },
    },
  },
};

// Array-shape hypothesis — parser must tolerate this too (proposal, pregunta NO-bloqueante #3).
const RECIBOS_ARRAY_ROOT_ARRAY_APLICACIONES = {
  error: 0,
  resultados: '1',
  recibos: [
    {
      id: '9003',
      cliente: { cliente_id: '100013', nombre: 'GOMEZ LUIS' },
      recaudador: 'mercadopago',
      fecha_recibo: '17-06-2026 09:00:00',
      fecha_confirmacion: '17-06-2026 09:01:00',
      fecha_anulacion: '00-00-0000 00:00:00',
      observaciones: null,
      aplicaciones: [
        { tipo: 'FB', sucursal: '00010', numero: '000074037', importe: 1000, fecha: '17-06-2026' },
      ],
    },
  ],
};

describe('GestionRealClient.parseReceiptsResponse', () => {
  it('parses the total from resultados', () => {
    const { total } = parseReceiptsResponse(RECIBOS_DICT_ROOT_DICT_APLICACIONES);
    expect(total).toBe(2);
  });

  it('normalizes a dict-keyed root into a flat list, using the object key as grReceiptId', () => {
    const { receipts } = parseReceiptsResponse(RECIBOS_DICT_ROOT_DICT_APLICACIONES);
    expect(receipts).toHaveLength(2);
    expect(receipts.map((r) => r.grReceiptId).sort()).toEqual(['9001', '9002']);
  });

  it('normalizes an array root into the same shape, using the array item id as grReceiptId', () => {
    const { receipts } = parseReceiptsResponse(RECIBOS_ARRAY_ROOT_ARRAY_APLICACIONES);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.grReceiptId).toBe('9003');
    expect(receipts[0]?.clienteGrId).toBe('100013');
  });

  it('normalizes dict-keyed aplicaciones without losing any entry', () => {
    const { receipts } = parseReceiptsResponse(RECIBOS_DICT_ROOT_DICT_APLICACIONES);
    const r9002 = receipts.find((r) => r.grReceiptId === '9002');
    expect(r9002?.applications).toHaveLength(2);
    expect(r9002?.applications.map((a) => a.numero).sort()).toEqual(['000000012', '000074036']);
  });

  it('normalizes array-form aplicaciones the same way', () => {
    const { receipts } = parseReceiptsResponse(RECIBOS_ARRAY_ROOT_ARRAY_APLICACIONES);
    expect(receipts[0]?.applications).toHaveLength(1);
    expect(receipts[0]?.applications[0]).toMatchObject({ tipo: 'FB', sucursal: '00010', numero: '000074037', importe: 1000 });
  });

  it('a receipt with 2+ aplicaciones produces 2+ rows, all sharing the header fields', () => {
    const { receipts } = parseReceiptsResponse(RECIBOS_DICT_ROOT_DICT_APLICACIONES);
    const r9002 = receipts.find((r) => r.grReceiptId === '9002')!;
    expect(r9002.recaudador).toBe('manual');
    expect(r9002.applications.every((a) => a.fecha === '16-06-2026')).toBe(true);
  });

  // gr-receipt-annulment (design.md Decision 3.1, scenario 1) — REWRITTEN:
  // this test used to be "excludes a receipt whose fecha_anulacion differs
  // from the GR centinela", pinning the exact bug this change exists to fix
  // (`GestionRealClient.ts:811`'s `if (isRealAnnulment(...)) continue;` — a
  // recibo anulado nunca llegaba al mapper, so `anulado` stayed hardcoded
  // `false` forever). The parser no longer decides on the domain: it passes
  // `fecha_anulacion` through RAW and lets `mapGrReceipt` derive the flag.
  it('INCLUDES a receipt whose fecha_anulacion differs from the GR centinela (real annulment), carrying fechaAnulacion raw, with its children still parsed', () => {
    const withVoided = {
      error: 0,
      resultados: '2',
      recibos: {
        '9001': RECIBOS_DICT_ROOT_DICT_APLICACIONES.recibos['9001'],
        '9099': {
          cliente: { cliente_id: '999', nombre: 'BAJA CARLOS' },
          recaudador: 'manual',
          fecha_recibo: '18-06-2026 10:00:00',
          fecha_confirmacion: null,
          fecha_anulacion: '20-06-2026 12:00:00', // REAL annulment
          observaciones: null,
          aplicaciones: { '1': { tipo: 'FB', sucursal: '00010', numero: '999', importe: 100, fecha: '18-06-2026' } },
          items: { '1': { banco: 'BANCO', caja_cuenta_id: '1', destino: 'CTA', fecha: '18-06-2026', importe: 100, moneda: 'PES', numero_transferencia: '1', tipo: 'transferencia' } },
          retenciones: { '1': { tipo: 'retgan', importe: 10, fecha: '18-06-2026' } },
        },
      },
    };
    const { receipts } = parseReceiptsResponse(withVoided);

    // PRESENCE first (the revert-probe discipline — a probe whose only
    // assertion is an absence gives false confidence against a world where
    // the row never existed at all).
    expect(receipts.map((r) => r.grReceiptId).sort()).toEqual(['9001', '9099']);
    const voided = receipts.find((r) => r.grReceiptId === '9099')!;
    expect(voided.fechaAnulacion).toBe('20-06-2026 12:00:00'); // carried RAW — the parser no longer decides
    // Children still parsed — no evidence destroyed (design.md 3.1, "las
    // hijas... se parsean y se persisten igual").
    expect(voided.applications).toHaveLength(1);
    expect(voided.items).toHaveLength(1);
    expect(voided.retenciones).toHaveLength(1);
  });

  // gr-receipt-annulment (design.md Decision 3.1) — REWRITTEN: `fechaAnulacion`
  // used to be hardcoded `null` by the parser (line :825, `fechaAnulacion: null`)
  // for EVERY receipt, voided or not — this test's OLD assertion
  // (`toBeNull()`) was true only because of that hardcode, not because the
  // centinela specifically maps to null. Now the raw value passes through
  // verbatim; `isRealAnnulment` (called downstream, in the mapper) is what
  // decides the centinela means "not annulled".
  it('a receipt whose fecha_anulacion equals the centinela exactly carries the RAW centinela string, not null', () => {
    const { receipts } = parseReceiptsResponse(RECIBOS_DICT_ROOT_DICT_APLICACIONES);
    const r9001 = receipts.find((r) => r.grReceiptId === '9001');
    expect(r9001).toBeDefined();
    expect(r9001?.fechaAnulacion).toBe('00-00-0000 00:00:00');
  });

  it('tolerates an empty recibos node without throwing', () => {
    expect(parseReceiptsResponse({ error: 0, resultados: '0', recibos: {} })).toEqual({ total: 0, receipts: [] });
    expect(parseReceiptsResponse({ error: 0, resultados: '0', recibos: [] })).toEqual({ total: 0, receipts: [] });
    expect(parseReceiptsResponse({})).toEqual({ total: 0, receipts: [] });
    expect(parseReceiptsResponse(null)).toEqual({ total: 0, receipts: [] });
  });

  // ── F1 — fechaRecibo must read `fecha_recibo`, not `fecha` ────────────────
  it('F1: reads fechaRecibo from `fecha_recibo` (the REAL field), never from `fecha`', () => {
    const { receipts } = parseReceiptsResponse(RECIBOS_DICT_ROOT_DICT_APLICACIONES);
    const r9001 = receipts.find((r) => r.grReceiptId === '9001');
    expect(r9001?.fechaRecibo).toBe('15-06-2026 10:00:00');
  });

  it('F1: a payload with only the WRONG `fecha` field (no `fecha_recibo`) yields a null fechaRecibo', () => {
    const wrongFieldOnly = {
      error: 0,
      resultados: '1',
      recibos: { '1': { ...RECIBOS_DICT_ROOT_DICT_APLICACIONES.recibos['9001'], fecha_recibo: undefined, fecha: '15-06-2026 10:00:00' } },
    };
    const { receipts } = parseReceiptsResponse(wrongFieldOnly);
    expect(receipts[0]?.fechaRecibo).toBeNull();
  });

  // ── F2 — clienteGrId must read the NESTED `cliente.cliente_id`, not the root ──
  it('F2: reads clienteGrId from the NESTED `cliente.cliente_id`, never the receipt root', () => {
    const { receipts } = parseReceiptsResponse(RECIBOS_DICT_ROOT_DICT_APLICACIONES);
    const r9001 = receipts.find((r) => r.grReceiptId === '9001');
    expect(r9001?.clienteGrId).toBe('100011');
  });

  it('F2: a root-level cliente_id (the WRONG shape) is ignored — clienteGrId stays null', () => {
    const rootLevelOnly = {
      error: 0,
      resultados: '1',
      recibos: { '1': { ...RECIBOS_DICT_ROOT_DICT_APLICACIONES.recibos['9001'], cliente: undefined, cliente_id: '100011' } },
    };
    const { receipts } = parseReceiptsResponse(rootLevelOnly);
    expect(receipts[0]?.clienteGrId).toBeNull();
  });

  // ── F3 — GR returns its OWN errors with HTTP 200; the parser must not treat them as an empty range ──
  describe('F3: GR error envelope (HTTP 200, no `recibos` node)', () => {
    it('throws when `error` is a non-zero code (measured: {"error":"91","descripcion":"No Se indicó la Acción"})', () => {
      expect(() => parseReceiptsResponse({ error: '91', descripcion: 'No Se indicó la Acción' })).toThrow(/91/);
    });

    it('the thrown message carries the descripcion so the SyncState error trail is legible', () => {
      expect(() => parseReceiptsResponse({ error: '91', descripcion: 'No Se indicó la Acción' })).toThrow(
        /No Se indic.* la Acci.*n/,
      );
    });

    it('does NOT throw for error:0 (the normal success envelope)', () => {
      expect(() => parseReceiptsResponse(RECIBOS_DICT_ROOT_DICT_APLICACIONES)).not.toThrow();
    });

    it('does NOT throw for a legitimate empty tail page (measured: offset=900, total=828, error:0, no recibos node)', () => {
      expect(parseReceiptsResponse({ error: 0, resultados: '828' })).toEqual({ total: 828, receipts: [] });
    });

    it('does NOT throw when `error` is the string "0"', () => {
      expect(() => parseReceiptsResponse({ error: '0', resultados: '0', recibos: {} })).not.toThrow();
    });
  });

  // ── F11 — grApplicationId must NEVER trust GR's own `id` (per-line index, collides globally) ──
  describe('F11: grApplicationId identity', () => {
    it('is ALWAYS the synthetic `${grReceiptId}-${key}`, even when GR supplies its own `aplicaciones[].id`', () => {
      const withOwnId = {
        error: 0,
        resultados: '1',
        recibos: {
          '9001': {
            ...RECIBOS_DICT_ROOT_DICT_APLICACIONES.recibos['9001'],
            aplicaciones: { '1': { id: '1', tipo: 'FB', sucursal: '00010', numero: '000074035', importe: 1500, fecha: '15-06-2026' } },
          },
        },
      };
      const { receipts } = parseReceiptsResponse(withOwnId);
      expect(receipts[0]?.applications[0]?.grApplicationId).toBe('9001-1');
    });

    it('two DIFFERENT receipts whose GR aplicacion.id both say "1" never collide (synthetic id is receipt-scoped)', () => {
      const collidingIds = {
        error: 0,
        resultados: '2',
        recibos: {
          '9001': { ...RECIBOS_DICT_ROOT_DICT_APLICACIONES.recibos['9001'], aplicaciones: { '1': { id: '1', tipo: 'FB', sucursal: '00010', numero: 'A', importe: 100, fecha: '15-06-2026' } } },
          '9002': { ...RECIBOS_DICT_ROOT_DICT_APLICACIONES.recibos['9002'], aplicaciones: { '1': { id: '1', tipo: 'FB', sucursal: '00010', numero: 'B', importe: 200, fecha: '16-06-2026' } } },
        },
      };
      const { receipts } = parseReceiptsResponse(collidingIds);
      const ids = receipts.flatMap((r) => r.applications.map((a) => a.grApplicationId));
      expect(new Set(ids).size).toBe(2);
      expect(ids.sort()).toEqual(['9001-1', '9002-1']);
    });

    // F11 (secondary, "mismo criterio"): if the `recibos` ROOT is ever an
    // array AND an individual item lacks its own `id`, the fallback key is
    // the ARRAY POSITIONAL INDEX — which is only unique WITHIN one page.
    // Passing `offset` disambiguates it across pages of the same paginated scan.
    it('an array-root receipt WITHOUT its own id falls back to an offset-scoped key, never a bare positional index', () => {
      const arrayNoId = {
        error: 0,
        resultados: '1',
        recibos: [
          { cliente: { cliente_id: '1' }, recaudador: null, fecha_recibo: '15-06-2026', fecha_confirmacion: null, fecha_anulacion: null, observaciones: null, aplicaciones: [] },
        ],
      };
      const page1 = parseReceiptsResponse(arrayNoId, 0);
      const page2 = parseReceiptsResponse(arrayNoId, 100);
      expect(page1.receipts[0]?.grReceiptId).not.toBe(page2.receipts[0]?.grReceiptId);
    });
  });

  // ── fix-wave-2 R1 — `items`/`retenciones` were previously discarded
  // entirely by the parser (only `aplicaciones` was read). Same dict/array
  // normalization + synthetic-id idiom as `aplicaciones` (F11).
  describe('R1: items (cash) and retenciones (tax certificates) are parsed, never discarded', () => {
    const withItemsAndRetenciones = {
      error: 0,
      resultados: '1',
      recibos: {
        '9001': {
          cliente: { cliente_id: '100011', nombre: 'ACOSTA JUAN' },
          recaudador: 'mercadopago',
          fecha_recibo: '15-06-2026',
          fecha_confirmacion: '15-06-2026 10:05:00',
          fecha_anulacion: '00-00-0000 00:00:00',
          observaciones: null,
          aplicaciones: {
            '1': { tipo: 'FB', sucursal: '00010', numero: '000074035', importe: '1500.00', fecha: '15-06-2026' },
          },
          items: {
            '1': {
              banco: 'BANCO NACION', caja_cuenta_id: '1', destino: 'CTA CTE',
              fecha: '15-06-2026', importe: '1200.00', moneda: 'PES',
              numero_transferencia: '000123', tipo: 'transferencia',
            },
          },
          retenciones: {
            '1': { tipo: 'retgan', importe: '300.00', fecha: '15-06-2026' },
          },
        },
      },
    };

    it('normalizes dict-keyed items without losing any entry, with the real field names', () => {
      const { receipts } = parseReceiptsResponse(withItemsAndRetenciones);
      expect(receipts[0]?.items).toHaveLength(1);
      expect(receipts[0]?.items?.[0]).toMatchObject({
        banco: 'BANCO NACION',
        cajaCuentaId: '1',
        destino: 'CTA CTE',
        importe: 1200,
        moneda: 'PES',
        numeroTransferencia: '000123',
        tipo: 'transferencia',
      });
    });

    it('normalizes dict-keyed retenciones without losing any entry', () => {
      const { receipts } = parseReceiptsResponse(withItemsAndRetenciones);
      expect(receipts[0]?.retenciones).toHaveLength(1);
      expect(receipts[0]?.retenciones?.[0]).toMatchObject({ tipo: 'retgan', importe: 300 });
    });

    it('items/retenciones ids are ALWAYS the synthetic receipt-scoped key, same F11 rationale as aplicaciones', () => {
      const { receipts } = parseReceiptsResponse(withItemsAndRetenciones);
      expect(receipts[0]?.items?.[0]?.grItemId).toBe('9001-item-1');
      expect(receipts[0]?.retenciones?.[0]?.grRetencionId).toBe('9001-ret-1');
    });

    it('a receipt with NO items node parses to an empty items array, never throws', () => {
      const noItems = { ...withItemsAndRetenciones.recibos['9001'], items: undefined };
      const { receipts } = parseReceiptsResponse({ error: 0, resultados: '1', recibos: { '1': noItems } });
      expect(receipts[0]?.items).toEqual([]);
    });

    it('a receipt with NO retenciones node parses to an empty retenciones array, never throws', () => {
      const noRet = { ...withItemsAndRetenciones.recibos['9001'], retenciones: undefined };
      const { receipts } = parseReceiptsResponse({ error: 0, resultados: '1', recibos: { '1': noRet } });
      expect(receipts[0]?.retenciones).toEqual([]);
    });

    // ── fix-wave-3 LOW — the two tests above use `items: undefined`/
    // `retenciones: undefined` (an ABSENT field), but the ground truth
    // measured against 100 real recibos is that GR sends `items`/
    // `retenciones` as an EXPLICIT `null` (items: null in 1/100 sampled;
    // retenciones: null in 99/100) — never an absent key. `undefined` and a
    // JSON `null` are NOT the same shape once the payload round-trips through
    // an HTTP client's JSON parser (a real `null` survives as `null`, not
    // `undefined`) — this is exactly F1's bug class (a fixture written with a
    // DIFFERENT assumption than the real payload). `toEntriesList` happens to
    // treat both the same way (`null && typeof null === 'object'` is falsy,
    // same short-circuit as `undefined`), so this passes today, but nothing
    // was pinning that the EXPLICIT-null case specifically was ever
    // exercised — these two tests close that gap with the REAL measured shape.
    it('a receipt with items EXPLICITLY null (measured GR shape, not merely absent) parses to an empty items array, never throws', () => {
      const nullItems = { ...withItemsAndRetenciones.recibos['9001'], items: null };
      const { receipts } = parseReceiptsResponse({ error: 0, resultados: '1', recibos: { '1': nullItems } });
      expect(receipts[0]?.items).toEqual([]);
    });

    it('a receipt with retenciones EXPLICITLY null (measured GR shape, not merely absent) parses to an empty retenciones array, never throws', () => {
      const nullRet = { ...withItemsAndRetenciones.recibos['9001'], retenciones: null };
      const { receipts } = parseReceiptsResponse({ error: 0, resultados: '1', recibos: { '1': nullRet } });
      expect(receipts[0]?.retenciones).toEqual([]);
    });

    it('importe arrives as a STRING (measured: 100% of aplicaciones/items/retenciones) and parses correctly', () => {
      const { receipts } = parseReceiptsResponse(withItemsAndRetenciones);
      expect(receipts[0]?.applications[0]?.importe).toBe(1500);
      expect(receipts[0]?.items?.[0]?.importe).toBe(1200);
      expect(receipts[0]?.retenciones?.[0]?.importe).toBe(300);
    });

    // ── fix-wave-2 LOW — grFloat had no AR-locale guard (`parseFloat`
    // truncates "1.234,56" at the comma → 1000x undercount, silently).
    it('LOW: an AR-locale importe ("1.234,56") parses to the CORRECT value, never truncated at the comma', () => {
      const withArLocale = {
        error: 0,
        resultados: '1',
        recibos: {
          '1': {
            ...withItemsAndRetenciones.recibos['9001'],
            aplicaciones: { '1': { tipo: 'FB', sucursal: '00010', numero: '1', importe: '1.234,56', fecha: '15-06-2026' } },
            items: { '1': { banco: null, caja_cuenta_id: null, destino: null, fecha: '15-06-2026', importe: '1.234,56', moneda: null, numero_transferencia: null, tipo: null } },
            retenciones: {},
          },
        },
      };
      const { receipts } = parseReceiptsResponse(withArLocale);
      expect(receipts[0]?.applications[0]?.importe).toBe(1234.56);
      expect(receipts[0]?.items?.[0]?.importe).toBe(1234.56);
    });
  });
});
