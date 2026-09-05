import { InMemoryAssistantInvoicesReader } from '@infrastructure/adapters/in-memory/InMemoryAssistantInvoicesReader';
import { assertFactsArePiiFree } from '@application/use-cases/assistant/assistantPiiGuard';

/**
 * ai-assistant-cobranzas (4.1 / DAT-2) — el gemelo in-memory de `AssistantInvoicesReader`.
 *
 * Lo que importa acá NO es "devuelve lo que le cargué". Es que **el anclaje por cliente vive
 * en el puerto** (un caller que se olvida el filtro no puede ver facturas de otro) y que la
 * proyección no arrastra identidad: el twin tiene que replicar la semántica campo a campo del
 * adapter Prisma, o el test del use case corre sobre una realidad distinta de la de producción.
 */
describe('InMemoryAssistantInvoicesReader', () => {
  function reader() {
    const r = new InMemoryAssistantInvoicesReader();
    r.seed('client-1', [
      {
        tipo: 'FC A',
        numero: '0001-00012345',
        vencimiento: '2026-09-10',
        saldo: 41410.56,
        pdfUrl: 'https://gr.example/pdf/1',
        couponPdfUrl: null,
        paymentUrl: 'https://mp.example/pay/1',
      },
    ]);
    r.seed('client-2', [
      {
        tipo: 'FC B',
        numero: '0002-00099999',
        vencimiento: '2026-09-11',
        saldo: 1000,
        pdfUrl: null,
        couponPdfUrl: null,
        paymentUrl: null,
      },
    ]);
    return r;
  }

  it('devuelve SOLO las facturas del cliente pedido (anclaje en el puerto)', async () => {
    const invoices = await reader().listOpenByClientId('client-1');

    expect(invoices).toHaveLength(1);
    expect(invoices[0].numero).toBe('0001-00012345');
  });

  it('cliente sin facturas cargadas ⇒ lista vacía, nunca las de otro', async () => {
    expect(await reader().listOpenByClientId('client-desconocido')).toEqual([]);
  });

  it('DAT-2 — la proyección no lleva NADA de identidad (assertFactsArePiiFree)', async () => {
    const invoices = await reader().listOpenByClientId('client-1');

    // El nombre del titular es lo primero que se cuela en un SELECT con spread.
    for (const inv of invoices) {
      expect(Object.keys(inv).sort()).toEqual(
        ['couponPdfUrl', 'numero', 'paymentUrl', 'pdfUrl', 'saldo', 'tipo', 'vencimiento'],
      );
    }
    expect(() =>
      assertFactsArePiiFree({ 'cliente.facturas': { facturas: invoices } }, ['Juan Pérez']),
    ).not.toThrow();
  });
});
