import { ListPortalPayments } from '@application/use-cases/portal/ListPortalPayments';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { Customer } from '@domain/entities/customer';
import type {
  PortalPaymentsReader,
  PortalPaymentReceiptRow,
} from '@domain/ports/PortalPaymentsReader';

/**
 * Anclado en el payload REAL de GR (verificado en vivo, pago del usuario 03-08-2026):
 *   recaudador "mercadopago", item { importe "2500.01", moneda "PES" },
 *   aplicacion { tipo "FB", sucursal "00010", numero "000080104" }
 * Esa factura YA NO EXISTE en el espejo (el replace-all la borro al pagarse) — por eso
 * `appliedTo` es el unico rastro del vinculo.
 */
function pagoReal(overrides: Partial<PortalPaymentReceiptRow> = {}): PortalPaymentReceiptRow {
  return {
    grReceiptId: '344174',
    fechaRecibo: '2026-08-03T00:00:00.000Z',
    recaudador: 'mercadopago',
    items: [{ amount: 2500.01, moneda: 'PES' }],
    retenciones: [],
    applications: [{ grInvoiceId: 'FB-00010-000080104', grType: 'FB', amount: 2500.01 }],
    ...overrides,
  };
}

class FakeReader implements PortalPaymentsReader {
  calls: Array<{ grClienteId: string; page?: number; limit?: number }> = [];
  constructor(private readonly rows: PortalPaymentReceiptRow[] = []) {}
  async listByGrClienteId(grClienteId: string, q: { page?: number; limit?: number }) {
    this.calls.push({ grClienteId, ...q });
    return { data: this.rows, total: this.rows.length, page: q.page ?? 1, limit: q.limit ?? 25 };
  }
}

function repoCon(grClienteId: string | null): CustomerRepository {
  return {
    findById: async (id: string) => ({ id, grClienteId } as unknown as Customer),
  } as unknown as CustomerRepository;
}

describe('ListPortalPayments — PAY-1', () => {
  it('PAY-1.2 — mapea el pago real: fecha, importe por moneda, medio y A QUE FACTURA', async () => {
    const reader = new FakeReader([pagoReal()]);
    const uc = new ListPortalPayments(repoCon('204366'), reader);

    const out = await uc.execute('client-a', {});

    expect(out.data).toEqual([
      {
        date: '2026-08-03T00:00:00.000Z',
        amounts: [{ currency: 'ARS', amount: 2500.01 }],
        method: 'mercadopago',
        appliedTo: [{ invoiceNumber: '000080104', amount: 2500.01 }],
      },
    ]);
  });

  it('PAY-1.1 — consulta con el grClienteId DERIVADO del cliente del token', async () => {
    const reader = new FakeReader([]);
    const uc = new ListPortalPayments(repoCon('204366'), reader);

    await uc.execute('client-a', { page: 2, limit: 10 });

    expect(reader.calls).toEqual([{ grClienteId: '204366', page: 2, limit: 10 }]);
  });

  it('PAY-1.1 — cliente SIN grClienteId ⇒ lista vacia y NI SE TOCA el reader', async () => {
    const reader = new FakeReader([pagoReal()]);
    const uc = new ListPortalPayments(repoCon(null), reader);

    const out = await uc.execute('client-a', {});

    expect(out).toEqual({ data: [], total: 0, page: 1, limit: 25 });
    expect(reader.calls).toEqual([]);
  });

  it('PAY-1.4 — un recibo con DOS monedas no las suma', async () => {
    const reader = new FakeReader([
      pagoReal({ items: [{ amount: 1000, moneda: 'PES' }, { amount: 12, moneda: 'DOL' }] }),
    ]);
    const uc = new ListPortalPayments(repoCon('204366'), reader);

    const out = await uc.execute('client-a', {});

    expect(out.data[0].amounts).toHaveLength(2);
    expect(out.data[0].amounts).toEqual(
      expect.arrayContaining([
        { currency: 'ARS', amount: 1000 },
        { currency: 'USD', amount: 12 },
      ]),
    );
  });

  it('FIX — recibo 100% RETENCION (sin items): el importe NO puede salir vacio', async () => {
    // Medido contra GR sobre 1.500 recibos: los 2 que traen retenciones NO traen
    // items. Antes esto devolvia `amounts: []` y el cliente veia "cancelo la factura
    // 000014454" sin ningun importe. La retencion es plata del cliente igual: la
    // retuvo para AFIP en vez de darnosla como cash, y le canceló la deuda lo mismo.
    const reader = new FakeReader([
      pagoReal({
        items: [],
        retenciones: [{ amount: 18831.27 }, { amount: 2019.33 }],
        applications: [{ grInvoiceId: 'FA-00010-000014454', grType: 'FA', amount: 20850.6 }],
      }),
    ]);
    const uc = new ListPortalPayments(repoCon('204366'), reader);

    const out = await uc.execute('client-a', {});

    expect(out.data[0].amounts).toEqual([{ currency: 'ARS', amount: 20850.6 }]);
    expect(out.data[0].appliedTo).toEqual([{ invoiceNumber: '000014454', amount: 20850.6 }]);
  });

  it('FIX — items Y retenciones en el mismo recibo se suman', async () => {
    const reader = new FakeReader([
      pagoReal({ items: [{ amount: 1000, moneda: 'PES' }], retenciones: [{ amount: 500 }] }),
    ]);
    const uc = new ListPortalPayments(repoCon('204366'), reader);
    expect((await uc.execute('client-a', {})).data[0].amounts).toEqual([{ currency: 'ARS', amount: 1500 }]);
  });

  it('FIX — invoiceNumber VACIO cae al id crudo, no a una factura sin numero', async () => {
    // La ingesta hace `numero: a.numero ?? ''` => grInvoiceId puede ser "FB-00010-":
    // tres partes con la ultima vacia. El fallback anterior no se disparaba.
    const reader = new FakeReader([
      pagoReal({ applications: [{ grInvoiceId: 'FB-00010-', grType: 'FB', amount: 10 }] }),
    ]);
    const uc = new ListPortalPayments(repoCon('204366'), reader);
    expect((await uc.execute('client-a', {})).data[0].appliedTo).toEqual([
      { invoiceNumber: 'FB-00010-', amount: 10 },
    ]);
  });

  it('el DTO NO expone las observaciones del recibo (texto libre del operador)', async () => {
    const reader = new FakeReader([pagoReal()]);
    const uc = new ListPortalPayments(repoCon('204366'), reader);
    const out = await uc.execute('client-a', {});
    expect(Object.keys(out.data[0]).sort()).toEqual(['amounts', 'appliedTo', 'date', 'method']);
  });

  it('PAY-1.3 — el importe NO sale de las aplicaciones', async () => {
    // Con retenciones, `aplicaciones` (deuda cancelada) EXCEDE el cash recibido.
    // Mostrar la aplicacion seria decirle al cliente que pago mas de lo que pago.
    const reader = new FakeReader([
      pagoReal({
        items: [{ amount: 900, moneda: 'PES' }],
        retenciones: [],
        applications: [{ grInvoiceId: 'FB-00010-000080104', grType: 'FB', amount: 1000 }],
      }),
    ]);
    const uc = new ListPortalPayments(repoCon('204366'), reader);

    const out = await uc.execute('client-a', {});

    expect(out.data[0].amounts).toEqual([{ currency: 'ARS', amount: 900 }]);
  });

  it('un recibo sin aplicaciones ⇒ appliedTo vacio, no rompe', async () => {
    const reader = new FakeReader([pagoReal({ applications: [] })]);
    const uc = new ListPortalPayments(repoCon('204366'), reader);

    const out = await uc.execute('client-a', {});
    expect(out.data[0].appliedTo).toEqual([]);
  });

  it('un grInvoiceId con forma inesperada no se pierde: se expone tal cual', async () => {
    const reader = new FakeReader([
      pagoReal({ applications: [{ grInvoiceId: 'RARO', grType: 'FB', amount: 10 }] }),
    ]);
    const uc = new ListPortalPayments(repoCon('204366'), reader);

    const out = await uc.execute('client-a', {});
    expect(out.data[0].appliedTo).toEqual([{ invoiceNumber: 'RARO', amount: 10 }]);
  });

  it('PAY-1.6 — preserva el envelope paginado del portal', async () => {
    const reader = new FakeReader([pagoReal(), pagoReal({ grReceiptId: '2' })]);
    const uc = new ListPortalPayments(repoCon('204366'), reader);

    const out = await uc.execute('client-a', { page: 1, limit: 25 });
    expect(out).toMatchObject({ total: 2, page: 1, limit: 25 });
    expect(out.data).toHaveLength(2);
  });
});
