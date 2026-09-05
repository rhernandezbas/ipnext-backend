import { ClienteRecibosHoyResolver } from '@infrastructure/adapters/assistant/ClienteRecibosHoyResolver';
import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { MOTIVO_GUIA } from '@infrastructure/adapters/assistant/assistantMotivoGuia';
import { assertFactsArePiiFree } from '@application/use-cases/assistant/assistantPiiGuard';
import type { Customer } from '@domain/entities/customer';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { AssistantThreadReader } from '@domain/ports/AssistantThreadReader';
import type { AssistantSubjectContext } from '@domain/ports/AssistantDataSourceRegistry';
import type { GrReceipt } from '@domain/entities/gestionReal';
import { customerFrom, grBalanceRow, FIXED_NOW } from '../../../helpers/customerFixture';

/**
 * ai-assistant-cobranzas (4.8 / D9 / DAT-4) — el resolver de `cliente.recibos_hoy`.
 *
 * La regla que gobierna este archivo entero: **"no pudimos consultar" NUNCA puede parecerse a
 * "no encontramos tu pago"**. Un cliente con el comprobante en la mano, mandado a la cola de
 * Administración porque GR estuvo caído dos minutos, es el peor modo de falla de R1 — y es un
 * error que produciríamos nosotros, con un dato ausente disfrazado de dato.
 */

const NOW = new Date('2026-09-04T13:00:00.000Z');

function receipt(over: Partial<GrReceipt> & { grReceiptId: string }): GrReceipt {
  return {
    clienteGrId: 'GR1',
    recaudador: 'mercadopago',
    fechaRecibo: '04-09-2026 10:15:00',
    fechaConfirmacion: null,
    fechaAnulacion: '00-00-0000',
    observaciones: null,
    applications: [],
    items: [],
    retenciones: [],
    ...over,
  } as GrReceipt;
}

function item(importe: number, numeroTransferencia: string | null, id = '1') {
  return {
    grItemId: id,
    banco: null,
    cajaCuentaId: null,
    destino: null,
    fecha: '04-09-2026',
    importe,
    moneda: null,
    numeroTransferencia,
    tipo: null,
  };
}

function customer(): Customer {
  return customerFrom({
    id: 'client-1',
    name: 'Juan Pérez',
    status: 'active',
    ...grBalanceRow('41410.56', new Date(FIXED_NOW.getTime() - 10 * 60 * 1000)),
  });
}

function customers(): CustomerRepository {
  return { findById: async () => customer() } as unknown as CustomerRepository;
}

function threadWith(filenames: string[]): AssistantThreadReader {
  return {
    readRecentTurns: async () => [
      { role: 'customer', text: 'hola', generatedByAssistant: false, attachmentFilenames: [] },
      { role: 'agent', text: 'hola!', generatedByAssistant: true, attachmentFilenames: [] },
      { role: 'customer', text: 'te paso el comprobante', generatedByAssistant: false, attachmentFilenames: filenames },
    ],
  };
}

const ctx: AssistantSubjectContext = { clientId: 'client-1', conversationId: 'conv-1', areaId: 'area-1' };

function resolverWith(receipts: GrReceipt[], filenames: string[], error?: Error) {
  const gr = new InMemoryGestionRealPort();
  gr.receipts = receipts;
  if (error) gr.clientReceiptsError = error;
  return {
    gr,
    resolver: new ClienteRecibosHoyResolver(customers(), gr, threadWith(filenames), () => NOW),
  };
}

describe('ClienteRecibosHoyResolver', () => {
  it('DAT-4 — recibo de hoy con "MercadoPago: <op>" ⇒ match con su importe', async () => {
    const { resolver } = resolverWith(
      [receipt({ grReceiptId: '1', items: [item(41410.56, 'MercadoPago: 177332834792')] })],
      ['comprobante_177332834792.pdf'],
    );

    const facts = await resolver.resolve(ctx);

    expect(facts.disponible).toBe(true);
    expect(facts.matchOperacion).toEqual({
      operacion: '177332834792',
      encontrado: true,
      importe: 41410.56,
    });
  });

  it('DAT-4 — comprobante cuya operación no figura en ningún recibo ⇒ `encontrado:false`', async () => {
    const { resolver } = resolverWith(
      [receipt({ grReceiptId: '1', items: [item(1000, 'MercadoPago: 999999999999')] })],
      ['comprobante_177332834792.pdf'],
    );

    const facts = await resolver.resolve(ctx);

    expect(facts.disponible).toBe(true);
    expect(facts.matchOperacion).toMatchObject({ encontrado: false, operacion: '177332834792' });
  });

  it('D9 — GR tira ⇒ `recibos_no_disponibles`, y NUNCA se afirma que no hay pago', async () => {
    const { resolver } = resolverWith([], ['comprobante_177332834792.pdf'], new Error('GR caído'));

    const facts = await resolver.resolve(ctx);

    expect(facts).toEqual({
      disponible: false,
      motivo: 'recibos_no_disponibles',
      guia: MOTIVO_GUIA.recibos_no_disponibles,
    });
    // Lo que NO puede estar: un `encontrado:false` que el modelo leería como "no pagaste".
    expect(facts.matchOperacion).toBeUndefined();
  });

  it('R5 — 2 recibos del MISMO importe hoy ⇒ `posibleDoblePago:true` (caso Bravo)', async () => {
    const { resolver } = resolverWith(
      [
        receipt({ grReceiptId: '1', fechaRecibo: '04-09-2026 10:15:00', items: [item(77997.19, 'MercadoPago: 1', 'a')] }),
        receipt({ grReceiptId: '2', fechaRecibo: '04-09-2026 10:17:00', items: [item(77997.19, 'MercadoPago: 2', 'b')] }),
      ],
      ['comprobante_000000000001.pdf'],
    );

    const facts = await resolver.resolve(ctx);

    expect(facts.posibleDoblePago).toBe(true);
  });

  it('importes distintos ⇒ NO es doble pago', async () => {
    const { resolver } = resolverWith(
      [
        receipt({ grReceiptId: '1', items: [item(77997.19, 'MercadoPago: 1', 'a')] }),
        receipt({ grReceiptId: '2', items: [item(1000, 'MercadoPago: 2', 'b')] }),
      ],
      [],
    );

    expect((await resolver.resolve(ctx)).posibleDoblePago).toBe(false);
  });

  it('D9 — la consulta va anclada al cliente y con fechas DD-MM-AAAA', async () => {
    const { gr, resolver } = resolverWith([], []);

    await resolver.resolve(ctx);

    expect(gr.clientReceiptsCalls[0]).toEqual({
      grClienteId: 'GR1',
      // Ventana HOY−1 (design D9, pregunta abierta): un pago de las 23:55 de anoche sigue
      // siendo el pago que el cliente está mostrando ahora.
      fechaDesde: '03-09-2026',
      fechaHasta: '04-09-2026',
    });
  });

  it('sin adjunto de comprobante ⇒ los recibos igual se emiten, sin operación que buscar', async () => {
    const { resolver } = resolverWith(
      [receipt({ grReceiptId: '1', items: [item(41410.56, 'MercadoPago: 177332834792')] })],
      [],
    );

    const facts = await resolver.resolve(ctx);

    expect(facts.matchOperacion).toMatchObject({ operacion: null, encontrado: false });
    expect((facts.recibos as unknown[])).toHaveLength(1);
  });

  it('cliente sin `grClienteId` ⇒ motivo, nunca una consulta sin ancla', async () => {
    const gr = new InMemoryGestionRealPort();
    const sinGr = {
      findById: async () => customerFrom({ id: 'client-1', name: 'Juan Pérez' }),
    } as unknown as CustomerRepository;

    const facts = await new ClienteRecibosHoyResolver(sinGr, gr, threadWith([]), () => NOW).resolve(ctx);

    expect(facts.motivo).toBe('recibos_no_disponibles');
    expect(gr.clientReceiptsCalls).toHaveLength(0);
  });

  it('SEC-1 — los hechos no llevan identidad (hora, recaudador, importe, referencias)', async () => {
    const { resolver } = resolverWith(
      [receipt({ grReceiptId: '1', items: [item(41410.56, 'MercadoPago: 177332834792')] })],
      ['comprobante_177332834792.pdf'],
    );

    const facts = await resolver.resolve(ctx);

    expect(() => assertFactsArePiiFree({ 'cliente.recibos_hoy': facts }, ['Juan Pérez'])).not.toThrow();
    expect(JSON.stringify(facts)).not.toContain('GR1'); // ni el id de GR viaja al prompt
  });
});

/**
 * ═══ FIX WAVE W5 ════════════════════════════════════════════════════════════
 *
 * La ventana de consulta es HOY−1 (D9) pero los hechos salían SIN fecha: `hora: '23:55'` de
 * ayer se leía como "hoy a las 23:55", y `detectDoublePayment` comparaba importes de los DOS
 * días — el mismo abono de ayer y de hoy disparaba un falso `posibleDoblePago` (y con él, el
 * label `administracion` y un mensaje que le dice al cliente que pagó dos veces).
 */
describe('ClienteRecibosHoyResolver — W5: la fecha viaja en el hecho y HOY manda', () => {
  it('W5: cada recibo emite su `fecha`, y el de ayer va marcado `esDeAyer`', async () => {
    const { resolver } = resolverWith(
      [
        receipt({ grReceiptId: '1', fechaRecibo: '03-09-2026 23:55:00', items: [item(41410.56, 'MercadoPago: 1', 'a')] }),
        receipt({ grReceiptId: '2', fechaRecibo: '04-09-2026 10:15:00', items: [item(1000, 'MercadoPago: 2', 'b')] }),
      ],
      [],
    );

    const facts = await resolver.resolve(ctx);

    expect(facts.recibos).toEqual([
      expect.objectContaining({ fecha: '03-09-2026', hora: '23:55', esDeAyer: true }),
      expect.objectContaining({ fecha: '04-09-2026', hora: '10:15', esDeAyer: false }),
    ]);
  });

  it('W5: mismo importe AYER y HOY NO es doble pago', async () => {
    const { resolver } = resolverWith(
      [
        receipt({ grReceiptId: '1', fechaRecibo: '03-09-2026 10:15:00', items: [item(77997.19, 'MercadoPago: 1', 'a')] }),
        receipt({ grReceiptId: '2', fechaRecibo: '04-09-2026 10:17:00', items: [item(77997.19, 'MercadoPago: 2', 'b')] }),
      ],
      [],
    );

    expect((await resolver.resolve(ctx)).posibleDoblePago).toBe(false);
  });

  it('W5: dos del mismo importe HOY siguen siendo doble pago (caso Bravo)', async () => {
    const { resolver } = resolverWith(
      [
        receipt({ grReceiptId: '1', fechaRecibo: '04-09-2026 10:15:00', items: [item(77997.19, 'MercadoPago: 1', 'a')] }),
        receipt({ grReceiptId: '2', fechaRecibo: '04-09-2026 10:17:00', items: [item(77997.19, 'MercadoPago: 2', 'b')] }),
      ],
      [],
    );

    expect((await resolver.resolve(ctx)).posibleDoblePago).toBe(true);
  });

  it('W5: el match de la operación se busca sólo entre los recibos de HOY', async () => {
    const { resolver } = resolverWith(
      [receipt({ grReceiptId: '1', fechaRecibo: '03-09-2026 23:55:00', items: [item(41410.56, 'MercadoPago: 177332834792')] })],
      ['comprobante_177332834792.pdf'],
    );

    const facts = await resolver.resolve(ctx);

    // El recibo de ayer sigue emitido como CONTEXTO (el modelo lo ve fechado), pero no se
    // presenta como el pago verificado de hoy.
    expect(facts.matchOperacion).toMatchObject({ encontrado: false });
    expect((facts.recibos as unknown[])).toHaveLength(1);
  });
});
