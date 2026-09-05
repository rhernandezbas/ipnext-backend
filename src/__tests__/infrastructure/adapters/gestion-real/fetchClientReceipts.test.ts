import axios from 'axios';
import { GestionRealClient } from '@infrastructure/adapters/gestion-real/GestionRealClient';
import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';

jest.mock('axios');

/**
 * ai-assistant-cobranzas (4.7 / D9 / DAT-4) — `fetchClientReceipts`: la llamada GR EN VIVO,
 * anclada al cliente, que verifica un comprobante contra los recibos de hoy.
 *
 * Tres invariantes, y ninguna es cosmética:
 *  1. **`cliente_id` viaja SIEMPRE.** Sin el ancla, `action:'recibos'` devuelve los recibos de
 *     TODOS los clientes — fuga de PII por omisión (por eso el parámetro es obligatorio en la
 *     firma del puerto, D9).
 *  2. **Las fechas van EXACTAMENTE como se las pasaron** (DD-MM-AAAA). `recibos` responde
 *     HTTP 500 —no un error 91— ante una fecha ISO: un `.toISOString()` acá sería una
 *     regresión silenciosa, no un error atrapado.
 *  3. **Los recibos ANULADOS quedan afuera.** Contar un recibo anulado como un pago recibido
 *     es decirle "ya está" a alguien cuyo pago se dio de baja.
 */

const RESPUESTA_REAL = {
  // Forma medida en vivo: `recibos` es un DICT indexado por id, no un array.
  error: '0',
  resultados: '2',
  recibos: {
    '344174': {
      id: '344174',
      cliente: { cliente_id: '204366' },
      recaudador: 'mercadopago',
      fecha_recibo: '04-09-2026 10:15:00',
      fecha_confirmacion: '04-09-2026 10:15:00',
      fecha_anulacion: '00-00-0000', // centinela: NO está anulado
      items: {
        '550823': { importe: '41410.56', numero_transferencia: 'MercadoPago: 177332834792' },
      },
    },
    '344175': {
      id: '344175',
      cliente: { cliente_id: '204366' },
      recaudador: 'manual',
      fecha_recibo: '04-09-2026 11:00:00',
      fecha_anulacion: '04-09-2026 11:30:00', // ANULADO de verdad
      items: {
        '550824': { importe: '9999.00', numero_transferencia: null },
      },
    },
  },
};

let postMock: jest.Mock;

function makeClient() {
  postMock = jest.fn();
  (axios.create as jest.Mock).mockReturnValue({ post: postMock } as unknown as ReturnType<typeof axios.create>);
  return new GestionRealClient({
    baseUrl: 'https://gr.test/',
    cuit: '20304050607',
    secret: 'SECRET',
    now: () => new Date('2026-09-04T12:00:00Z'),
    sleep: async () => {},
  });
}

beforeEach(() => jest.clearAllMocks());

describe('GestionRealClient.fetchClientReceipts (D9)', () => {
  it('DAT-4 — postea `action:recibos` + `cliente_id` + fechas DD-MM-AAAA sin reformatear', async () => {
    const client = makeClient();
    postMock.mockResolvedValue({ data: RESPUESTA_REAL });

    await client.fetchClientReceipts({
      grClienteId: '204366',
      fechaDesde: '03-09-2026',
      fechaHasta: '04-09-2026',
    });

    const [, payload] = postMock.mock.calls[0];
    expect(payload).toMatchObject({
      action: 'recibos',
      cliente_id: 204366,
      fecha_desde: '03-09-2026',
      fecha_hasta: '04-09-2026',
    });
  });

  it('DAT-4 — parsea el DICT `recibos` reusando el parser de la ingesta global', async () => {
    const client = makeClient();
    postMock.mockResolvedValue({ data: RESPUESTA_REAL });

    const { receipts, total } = await client.fetchClientReceipts({
      grClienteId: '204366',
      fechaDesde: '04-09-2026',
      fechaHasta: '04-09-2026',
    });

    expect(total).toBe(2); // `resultados` de GR, ANTES del filtro de anulados
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      grReceiptId: '344174',
      clienteGrId: '204366',
      recaudador: 'mercadopago',
      fechaRecibo: '04-09-2026 10:15:00',
    });
  });

  it('DAT-4 — `numero_transferencia` SOBREVIVE al parseo (es el campo del match)', async () => {
    const client = makeClient();
    postMock.mockResolvedValue({ data: RESPUESTA_REAL });

    const { receipts } = await client.fetchClientReceipts({
      grClienteId: '204366',
      fechaDesde: '04-09-2026',
      fechaHasta: '04-09-2026',
    });

    expect(receipts[0].items).toHaveLength(1);
    expect(receipts[0].items?.[0]).toMatchObject({
      importe: 41410.56,
      numeroTransferencia: 'MercadoPago: 177332834792',
    });
  });

  it('los ANULADOS (fecha_anulacion real, ≠ 00-00-0000) quedan afuera', async () => {
    const client = makeClient();
    postMock.mockResolvedValue({ data: RESPUESTA_REAL });

    const { receipts } = await client.fetchClientReceipts({
      grClienteId: '204366',
      fechaDesde: '04-09-2026',
      fechaHasta: '04-09-2026',
    });

    expect(receipts.map((r) => r.grReceiptId)).not.toContain('344175');
  });

  it('un sobre de error de GR (HTTP 200) TIRA — nunca "no hay recibos"', async () => {
    const client = makeClient();
    postMock.mockResolvedValue({ data: { error: '90', descripcion: 'No tiene Acceso' } });

    // Un `{receipts: []}` acá sería indistinguible de "el cliente no pagó": el peor modo de
    // falla de esta regla (mandar a Administración a alguien que SÍ pagó).
    await expect(
      client.fetchClientReceipts({ grClienteId: '204366', fechaDesde: '04-09-2026', fechaHasta: '04-09-2026' }),
    ).rejects.toThrow(/GR recibos error 90/);
  });
});

/**
 * El gemelo in-memory tiene que replicar la MISMA semántica campo a campo: si acá el filtro
 * por cliente o por ventana no existiera, los tests del resolver correrían sobre una realidad
 * distinta de la de producción (`fixture-plausible-vs-producible`).
 */
describe('InMemoryGestionRealPort.fetchClientReceipts', () => {
  function port() {
    const gr = new InMemoryGestionRealPort();
    gr.receipts = [
      {
        grReceiptId: '344174',
        clienteGrId: '204366',
        recaudador: 'mercadopago',
        fechaRecibo: '04-09-2026 10:15:00',
        fechaConfirmacion: '04-09-2026 10:15:00',
        fechaAnulacion: '00-00-0000',
        observaciones: null,
        applications: [],
        items: [
          {
            grItemId: '344174-item-550823',
            banco: null,
            cajaCuentaId: null,
            destino: null,
            fecha: '04-09-2026',
            importe: 41410.56,
            moneda: null,
            numeroTransferencia: 'MercadoPago: 177332834792',
            tipo: null,
          },
        ],
        retenciones: [],
      },
      {
        grReceiptId: '344180',
        clienteGrId: '999999', // OTRO cliente
        recaudador: 'mercadopago',
        fechaRecibo: '04-09-2026 10:20:00',
        fechaConfirmacion: null,
        fechaAnulacion: '00-00-0000',
        observaciones: null,
        applications: [],
        items: [],
        retenciones: [],
      },
      {
        grReceiptId: '344181',
        clienteGrId: '204366',
        recaudador: 'manual',
        fechaRecibo: '01-09-2026 09:00:00', // fuera de la ventana
        fechaConfirmacion: null,
        fechaAnulacion: '00-00-0000',
        observaciones: null,
        applications: [],
        items: [],
        retenciones: [],
      },
      {
        grReceiptId: '344182',
        clienteGrId: '204366',
        recaudador: 'manual',
        fechaRecibo: '04-09-2026 11:00:00',
        fechaConfirmacion: null,
        fechaAnulacion: '04-09-2026 11:30:00', // anulado
        observaciones: null,
        applications: [],
        items: [],
        retenciones: [],
      },
    ];
    return gr;
  }

  it('filtra por cliente, por ventana y excluye anulados (misma semántica que el real)', async () => {
    const gr = port();

    const { receipts } = await gr.fetchClientReceipts({
      grClienteId: '204366',
      fechaDesde: '04-09-2026',
      fechaHasta: '04-09-2026',
    });

    expect(receipts.map((r) => r.grReceiptId)).toEqual(['344174']);
  });

  it('registra la llamada para poder assertear el ancla', async () => {
    const gr = port();
    await gr.fetchClientReceipts({ grClienteId: '204366', fechaDesde: '04-09-2026', fechaHasta: '04-09-2026' });

    expect(gr.clientReceiptsCalls[0].grClienteId).toBe('204366');
  });

  it('permite inyectar un fallo de GR (el resolver debe poder probar el `disponible:false`)', async () => {
    const gr = port();
    gr.clientReceiptsError = new Error('GR caído');

    await expect(
      gr.fetchClientReceipts({ grClienteId: '204366', fechaDesde: '04-09-2026', fechaHasta: '04-09-2026' }),
    ).rejects.toThrow('GR caído');
  });
});
