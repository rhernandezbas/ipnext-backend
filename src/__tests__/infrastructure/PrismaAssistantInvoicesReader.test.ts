import { PrismaAssistantInvoicesReader } from '@infrastructure/adapters/prisma/PrismaAssistantInvoicesReader';
import { prisma } from '@infrastructure/database/prisma';

/**
 * ai-assistant-cobranzas (4.4 / DAT-2) — el anclaje por cliente y la proyección SIN identidad
 * viven en el WHERE y en el SELECT del ADAPTER REAL, no sólo en el gemelo in-memory.
 *
 * Lección `invariante-sin-test-en-el-adapter-real` (mismo molde que
 * `PrismaPortalPaymentsReader.test.ts`): si el filtro por `clientId` o el `select` explícito
 * sólo estuvieran testeados contra el twin, borrarlos del Prisma real dejaría la suite entera
 * en verde — y `Invoice.customerName` (el nombre del titular, que la tabla SÍ tiene) se
 * filtraría a los hechos del modelo.
 */
describe('PrismaAssistantInvoicesReader', () => {
  afterEach(() => jest.restoreAllMocks());

  function espiar(rows: unknown[] = []) {
    const args: Record<string, unknown>[] = [];
    jest.spyOn(prisma.invoice, 'findMany').mockImplementation((async (a: Record<string, unknown>) => {
      args.push(a);
      return rows;
    }) as never);
    return args;
  }

  it('DAT-2 — filtra por clientId en el WHERE (el ancla vive en el puerto)', async () => {
    const args = espiar();
    await new PrismaAssistantInvoicesReader().listOpenByClientId('client-1');

    expect((args[0].where as { clientId?: unknown }).clientId).toBe('client-1');
  });

  it('DAT-2 — el SELECT es explícito y NO proyecta customerName ni identidad', async () => {
    const args = espiar();
    await new PrismaAssistantInvoicesReader().listOpenByClientId('client-1');

    const select = args[0].select as Record<string, unknown>;
    expect(select).toBeDefined();
    expect(Object.keys(select).sort()).toEqual(
      ['balance', 'couponPdfUrl', 'dueDate', 'grType', 'number', 'paymentUrl', 'pdfUrl'],
    );
    expect(select.customerName).toBeUndefined();
    expect(select.client).toBeUndefined();
    // Un `include` reabriría la puerta que el `select` cierra.
    expect(args[0].include).toBeUndefined();
  });

  it('sólo facturas ABIERTAS: las pagadas no entran al bloque de cobranza', async () => {
    const args = espiar();
    await new PrismaAssistantInvoicesReader().listOpenByClientId('client-1');

    const where = args[0].where as { status?: { in?: string[] } };
    expect(where.status?.in).toEqual(expect.arrayContaining(['pendiente', 'vencida']));
    expect(where.status?.in).not.toContain('pagada');
  });

  it('mapea los Decimal de Prisma a numeros (el hecho no puede llevar Decimal)', async () => {
    const decimal = (n: number) => ({ toNumber: () => n });
    espiar([
      {
        number: '0001-00012345',
        grType: 'FC A',
        dueDate: new Date('2026-09-10T00:00:00.000Z'),
        balance: decimal(41410.56),
        pdfUrl: 'https://gr.example/pdf/1',
        couponPdfUrl: null,
        paymentUrl: 'https://mp.example/pay/1',
      },
    ]);

    const [factura] = await new PrismaAssistantInvoicesReader().listOpenByClientId('client-1');

    expect(factura).toEqual({
      tipo: 'FC A',
      numero: '0001-00012345',
      vencimiento: '2026-09-10T00:00:00.000Z',
      saldo: 41410.56,
      pdfUrl: 'https://gr.example/pdf/1',
      couponPdfUrl: null,
      paymentUrl: 'https://mp.example/pay/1',
    });
  });

  it('D8 — el link "pagar todo junto" sale de Client.grPaymentUrl, anclado por id', async () => {
    const args: Record<string, unknown>[] = [];
    jest.spyOn(prisma.client, 'findUnique').mockImplementation((async (a: Record<string, unknown>) => {
      args.push(a);
      return { grPaymentUrl: 'https://mp.example/total' };
    }) as never);

    const url = await new PrismaAssistantInvoicesReader().findTotalPaymentUrlByClientId('client-1');

    expect(url).toBe('https://mp.example/total');
    expect(args[0].where).toEqual({ id: 'client-1' });
    expect(args[0].select).toEqual({ grPaymentUrl: true });
  });

  it('cliente inexistente ⇒ null, nunca una excepción que tumbe el resolver', async () => {
    jest.spyOn(prisma.client, 'findUnique').mockImplementation((async () => null) as never);

    expect(await new PrismaAssistantInvoicesReader().findTotalPaymentUrlByClientId('nope')).toBeNull();
  });
});
