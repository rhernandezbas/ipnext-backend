import { PrismaPortalPaymentsReader } from '@infrastructure/adapters/prisma/PrismaPortalPaymentsReader';
import { prisma } from '@infrastructure/database/prisma';

/**
 * PAY-2.1 — el anclaje por cliente y el filtro de anulados viven en el WHERE del
 * ADAPTER REAL, no solo en el use case.
 *
 * Leccion `invariante-sin-test-en-el-adapter-real`: los 5 filtros que impiden que un
 * cliente vea los datos de OTRO estaban testeados unicamente en el gemelo in-memory
 * — borrarlos del Prisma real dejaba la suite entera en verde. Estos tests corren
 * sobre la clase que efectivamente corre en produccion.
 */
describe('PrismaPortalPaymentsReader', () => {
  afterEach(() => jest.restoreAllMocks());

  function espiar(rows: unknown[] = [], total = 0) {
    const args: Record<string, unknown>[] = [];
    jest.spyOn(prisma.financePaymentReceipt, 'findMany').mockImplementation((async (a: Record<string, unknown>) => {
      args.push(a);
      return rows;
    }) as never);
    jest.spyOn(prisma.financePaymentReceipt, 'count').mockImplementation((async (a: Record<string, unknown>) => {
      args.push(a);
      return total;
    }) as never);
    return args;
  }

  it('PAY-2.1 — filtra por clientGrId en el WHERE (anti-IDOR estructural)', async () => {
    const args = espiar();
    await new PrismaPortalPaymentsReader().listByGrClienteId('204366', {});

    for (const a of args) {
      expect((a.where as { clientGrId?: unknown }).clientGrId).toBe('204366');
    }
    expect(args.length).toBeGreaterThanOrEqual(2); // findMany + count, los DOS filtrados
  });

  it('PAY-1.5 — excluye los recibos ANULADOS en el WHERE', async () => {
    const args = espiar();
    await new PrismaPortalPaymentsReader().listByGrClienteId('204366', {});

    for (const a of args) {
      expect((a.where as { anulado?: unknown }).anulado).toBe(false);
    }
  });

  it('PAY-1.6 — ordena por fecha DESC y pagina', async () => {
    const args = espiar();
    await new PrismaPortalPaymentsReader().listByGrClienteId('204366', { page: 3, limit: 10 });

    const find = args.find((a) => a.orderBy) as {
      orderBy: { fechaRecibo: string }; skip: number; take: number;
    };
    // `nulls:'last'` + desempate: sin eso los recibos sin fecha van arriba de todo
    // (Postgres DESC = NULLS FIRST) y el paginado puede duplicar/perder filas.
    expect(find.orderBy).toEqual([
      { fechaRecibo: { sort: 'desc', nulls: 'last' } },
      { grReceiptId: 'desc' },
    ]);
    expect(find.skip).toBe(20);
    expect(find.take).toBe(10);
  });

  it('trae items y aplicaciones en la MISMA query (sin N+1)', async () => {
    const args = espiar();
    await new PrismaPortalPaymentsReader().listByGrClienteId('204366', {});

    const find = args.find((a) => a.include) as { include: Record<string, unknown> };
    expect(find.include).toEqual({ items: true, applications: true, retenciones: true });
  });

  it('mapea los Decimal de Prisma a numeros (el DTO no puede llevar Decimal)', async () => {
    const decimal = (n: number) => ({ toNumber: () => n });
    espiar(
      [
        {
          grReceiptId: '344174',
          clientGrId: '204366',
          fechaRecibo: new Date('2026-08-03T00:00:00.000Z'),
          recaudador: 'mercadopago',
          items: [{ amount: decimal(2500.01), moneda: 'PES' }],
          retenciones: [{ amount: decimal(120.5) }],
          applications: [{ grInvoiceId: 'FB-00010-000080104', grType: 'FB', amount: decimal(2500.01) }],
        },
      ],
      1,
    );

    const out = await new PrismaPortalPaymentsReader().listByGrClienteId('204366', {});

    expect(out.total).toBe(1);
    expect(out.data[0]).toEqual({
      grReceiptId: '344174',
      fechaRecibo: '2026-08-03T00:00:00.000Z',
      recaudador: 'mercadopago',
      items: [{ amount: 2500.01, moneda: 'PES' }],
      retenciones: [{ amount: 120.5 }],
      applications: [{ grInvoiceId: 'FB-00010-000080104', grType: 'FB', amount: 2500.01 }],
    });
  });

  it('un recibo sin fecha no rompe: fechaRecibo null', async () => {
    espiar([{ grReceiptId: 'x', fechaRecibo: null, recaudador: null, items: [], retenciones: [], applications: [] }], 1);
    const out = await new PrismaPortalPaymentsReader().listByGrClienteId('204366', {});
    expect(out.data[0].fechaRecibo).toBeNull();
  });

  // ── gr-receipt-annulment (design.md Decision 3.3 spec-conflict-adjacent
  // note; spec.md portal-payments scenarios 27/28/29) — the PREVIOUS PAY-1.5
  // test above only asserted the SHAPE of the `where` clause; it never
  // proved the filter actually EXCLUDES an anulado row. Now that the ingest
  // can genuinely produce `anulado: true` (gr-receipt-annulment stopped
  // excluding voided receipts upstream), this closes the gap with a mock
  // that ACTUALLY applies `where.anulado`/`where.clientGrId`, molde a real
  // Prisma query — and the probe discipline: PRESENCE in the fixture is
  // asserted BEFORE its absence from the result (a probe whose only
  // assertion is an absence gives false confidence against a world where the
  // row never existed).
  describe('gr-receipt-annulment: genuine anulado exclusion (not just a where-shape check)', () => {
    function espiarConFiltro(fixture: Array<{ grReceiptId: string; clientGrId: string; anulado: boolean; fechaRecibo: Date; recaudador: string | null; items: unknown[]; retenciones: unknown[]; applications: unknown[] }>) {
      jest.spyOn(prisma.financePaymentReceipt, 'findMany').mockImplementation((async (a: Record<string, unknown>) => {
        const where = a.where as { clientGrId: string; anulado: boolean };
        return fixture.filter((r) => r.clientGrId === where.clientGrId && r.anulado === where.anulado);
      }) as never);
      jest.spyOn(prisma.financePaymentReceipt, 'count').mockImplementation((async (a: Record<string, unknown>) => {
        const where = a.where as { clientGrId: string; anulado: boolean };
        return fixture.filter((r) => r.clientGrId === where.clientGrId && r.anulado === where.anulado).length;
      }) as never);
    }

    it('scenario 27/28 — a real anulado receipt with a non-zero amount is PRESENT in the fixture but ABSENT from the result; the healthy sibling still appears (scenario 29)', async () => {
      const decimal = (n: number) => ({ toNumber: () => n });
      const fixture = [
        {
          grReceiptId: 'sano-1', clientGrId: '204366', anulado: false,
          fechaRecibo: new Date('2026-08-03T00:00:00.000Z'), recaudador: 'mercadopago',
          items: [{ amount: decimal(2500.01), moneda: 'PES' }], retenciones: [], applications: [],
        },
        {
          grReceiptId: 'anulado-1', clientGrId: '204366', anulado: true,
          fechaRecibo: new Date('2026-08-04T00:00:00.000Z'), recaudador: 'mercadopago',
          items: [{ amount: decimal(9999.99), moneda: 'PES' }], retenciones: [], applications: [],
        },
      ];
      // PRESENCE first — the anulado row genuinely exists in the fixture,
      // with a non-zero amount (a probe of ausencia no discrimina).
      const anuladoRow = fixture.find((r) => r.grReceiptId === 'anulado-1');
      expect(anuladoRow).toBeDefined();
      expect(anuladoRow?.items[0]?.amount.toNumber()).toBe(9999.99);

      espiarConFiltro(fixture);
      const out = await new PrismaPortalPaymentsReader().listByGrClienteId('204366', {});

      // NOW assert the absence — after presence was already proven.
      expect(out.data.map((d) => d.grReceiptId)).toEqual(['sano-1']);
      expect(out.total).toBe(1);
      // scenario 29 — the never-anulado receipt keeps its normal shape.
      expect(out.data[0]).toMatchObject({ grReceiptId: 'sano-1', recaudador: 'mercadopago' });
      // scenario 28 (revert-probe, applied for real in Fase 8): because this
      // mock filters on `where.anulado` faithfully, removing `anulado: false`
      // from the REAL `where` object would make the mock return BOTH rows —
      // the `toEqual(['sano-1'])` assertion above would fail with
      // `['sano-1', 'anulado-1']` instead. That is the actual mutant task 8.11 applies.
    });
  });
});
