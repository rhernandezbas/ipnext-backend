import { PrismaInvoiceDetailReader } from '@infrastructure/adapters/prisma/PrismaInvoiceDetailReader';
import { prisma } from '@infrastructure/database/prisma';

/**
 * whatsapp-invoice-detail-quickreply (Phase 3, QR-2/QR-3) — mismo molde de test
 * que `PrismaAssistantInvoicesReader.test.ts` (invariante-sin-test-en-el-adapter-
 * real): el filtro por `clientId`/status y el `select` explícito se testean
 * contra el Prisma REAL, no solo el twin in-memory. Archivo NUEVO, sin import
 * de `assistant/*` (QR-2).
 */
describe('PrismaInvoiceDetailReader', () => {
  afterEach(() => jest.restoreAllMocks());

  function espiar(rows: unknown[] = []) {
    const args: Record<string, unknown>[] = [];
    jest.spyOn(prisma.invoice, 'findMany').mockImplementation((async (a: Record<string, unknown>) => {
      args.push(a);
      return rows;
    }) as never);
    return args;
  }

  it('filtra por clientId en el WHERE', async () => {
    const args = espiar();
    await new PrismaInvoiceDetailReader().listOpenByClientId('client-1');

    expect((args[0].where as { clientId?: unknown }).clientId).toBe('client-1');
  });

  it('solo facturas pendiente/vencida, orderBy dueDate asc', async () => {
    const args = espiar();
    await new PrismaInvoiceDetailReader().listOpenByClientId('client-1');

    const where = args[0].where as { status?: { in?: string[] } };
    expect(where.status?.in).toEqual(expect.arrayContaining(['pendiente', 'vencida']));
    expect(where.status?.in).not.toContain('pagada');
    expect(args[0].orderBy).toEqual({ dueDate: 'asc' });
  });

  it('SELECT explícito, sin customerName ni include (no PII)', async () => {
    const args = espiar();
    await new PrismaInvoiceDetailReader().listOpenByClientId('client-1');

    const select = args[0].select as Record<string, unknown>;
    expect(select).toBeDefined();
    expect(Object.keys(select).sort()).toEqual(['balance', 'dueDate', 'grType', 'number', 'paymentUrl', 'pdfUrl']);
    expect(select.customerName).toBeUndefined();
    expect(select.client).toBeUndefined();
    expect(args[0].include).toBeUndefined();
  });

  it('mapea filas a InvoiceDetailInvoice, incluyendo Decimal → número', async () => {
    const decimal = (n: number) => ({ toNumber: () => n });
    espiar([
      {
        number: '0001-00012345',
        grType: 'FC A',
        dueDate: new Date('2026-09-10T00:00:00.000Z'),
        balance: decimal(41410.56),
        pdfUrl: 'https://gr.example/pdf/1',
        paymentUrl: 'https://mp.example/pay/1',
      },
    ]);

    const [factura] = await new PrismaInvoiceDetailReader().listOpenByClientId('client-1');

    expect(factura).toEqual({
      tipo: 'FC A',
      numero: '0001-00012345',
      vencimiento: '2026-09-10T00:00:00.000Z',
      saldo: 41410.56,
      pdfUrl: 'https://gr.example/pdf/1',
      paymentUrl: 'https://mp.example/pay/1',
    });
  });

  it('grType ausente → tipo neutro "Factura" (nunca inventado)', async () => {
    espiar([
      {
        number: '0001-1',
        grType: null,
        dueDate: new Date('2026-09-10T00:00:00.000Z'),
        balance: 100,
        pdfUrl: null,
        paymentUrl: null,
      },
    ]);

    const [factura] = await new PrismaInvoiceDetailReader().listOpenByClientId('client-1');

    expect(factura.tipo).toBe('Factura');
    expect(factura.pdfUrl).toBeNull();
    expect(factura.paymentUrl).toBeNull();
  });

  it('lista vacía → []', async () => {
    espiar([]);

    expect(await new PrismaInvoiceDetailReader().listOpenByClientId('client-1')).toEqual([]);
  });
});
