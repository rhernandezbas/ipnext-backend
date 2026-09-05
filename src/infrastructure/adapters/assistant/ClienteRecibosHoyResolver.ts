import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { GestionRealPort } from '@domain/ports/GestionRealPort';
import type { AssistantThreadReader } from '@domain/ports/AssistantThreadReader';
import type {
  AssistantDataSourceResolver,
  AssistantSubjectContext,
} from '@domain/ports/AssistantDataSourceRegistry';
import type { GrReceipt } from '@domain/entities/gestionReal';
import {
  detectDoublePayment,
  extractComprobanteOperacion,
  matchReceiptOperation,
  type ReceiptFact,
} from '@application/use-cases/assistant/comprobantes';
import { motivoNoDisponible } from './assistantMotivoGuia';

/** Turnos de hilo que se leen para encontrar el adjunto del comprobante. */
const THREAD_TURN_LIMIT = 20;

/**
 * ai-assistant-cobranzas (4.8 / D9 / DAT-4) — fuente `cliente.recibos_hoy`.
 *
 * Molde `ClienteSaldoResolver`, con una regla propia que domina todo el archivo:
 * **"no pudimos consultar" NO es "no encontramos tu pago".** GR caído, cliente sin
 * `grClienteId`, timeout ⇒ `disponible:false, motivo:'recibos_no_disponibles'`, y NUNCA un
 * `matchOperacion.encontrado:false`, que el modelo leería —con razón— como "tu pago no
 * figura". Mandar a la cola de Administración a alguien que SÍ pagó, con el comprobante en la
 * mano, es el peor modo de falla de R1 (D9).
 *
 * **Por qué esto sale de GR EN VIVO y no del espejo `FinancePaymentReceipt`** (que existe y sí
 * guarda `numeroTransferencia`): lo alimenta un scheduler por delta, con tick de minutos y
 * kill-switch. Un pago de hace dos minutos puede no estar ahí todavía. Acá la frescura no es
 * una optimización: es la corrección.
 *
 * La ventana es HOY−1 (recomendación de la pregunta abierta de D9): un pago hecho a las 23:55
 * de anoche es exactamente el pago que el cliente está mostrando esta mañana.
 *
 * `matchOperacion` y `posibleDoblePago` los calcula CÓDIGO (funciones puras de
 * `comprobantes.ts`), nunca el modelo: son un `includes` y una comparación en centavos, y el
 * resultado decide si le decimos a alguien que su deuda quedó saldada.
 */
export class ClienteRecibosHoyResolver implements AssistantDataSourceResolver {
  readonly key = 'cliente.recibos_hoy';

  constructor(
    private readonly customers: CustomerRepository,
    private readonly gr: GestionRealPort,
    /**
     * El número de operación sale del NOMBRE del adjunto del último inbound
     * (`comprobante_<op>.pdf`, D11). El resolver sólo recibe `clientId`/`conversationId`
     * (SEC-1: el contexto no lleva ni puede llevar contenido), así que el hilo se lee acá,
     * por el MISMO puerto angosto que usa el motor.
     */
    private readonly thread: AssistantThreadReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async resolve(ctx: AssistantSubjectContext): Promise<Record<string, unknown>> {
    if (!ctx.clientId) return motivoNoDisponible('cliente_no_identificado');

    const customer = await this.customers.findById(ctx.clientId);
    // Sin ancla no se consulta: `action:'recibos'` sin `cliente_id` devuelve los recibos de
    // TODOS los clientes (fuga de PII por omisión, D9).
    if (!customer.grClienteId) return motivoNoDisponible('recibos_no_disponibles');

    const operacion = await this.extractOperacion(ctx.conversationId);

    let receipts: GrReceipt[];
    try {
      const result = await this.gr.fetchClientReceipts({
        grClienteId: customer.grClienteId,
        fechaDesde: grDate(addDays(this.now(), -1)),
        fechaHasta: grDate(this.now()),
      });
      receipts = result.receipts;
    } catch (err) {
      // ⚠️ El `catch` MÁS importante del change. Degradar a `{recibos: [], encontrado:false}`
      // sería indistinguible de "el cliente no pagó".
      // eslint-disable-next-line no-console
      console.error('[assistant] cliente.recibos_hoy — GR no respondió', {
        error: err instanceof Error ? err.message : err,
      });
      return motivoNoDisponible('recibos_no_disponibles');
    }

    const hoy = grDate(this.now());
    const recibos = receipts.map((r) => toReceiptFact(r, hoy));
    /**
     * fix wave W5 — la VENTANA de consulta es HOY−1 (un pago de las 23:55 de anoche es el que
     * el cliente muestra esta mañana), pero el match y el doble pago se evalúan SÓLO sobre los
     * de HOY. Los de ayer viajan igual como CONTEXTO, fechados y con `esDeAyer:true`.
     *
     * El falso `posibleDoblePago` era real: el mismo abono de ayer y el de hoy tienen el mismo
     * importe: le decíamos al cliente que pagó dos veces y lo mandábamos a caja.
     */
    const deHoy = recibos.filter((r) => !r.esDeAyer);

    return {
      disponible: true,
      recibos,
      matchOperacion: matchReceiptOperation(operacion, deHoy),
      posibleDoblePago: detectDoublePayment(deHoy),
    };
  }

  /** `null` si el último inbound no trae un adjunto `comprobante_<op>.*`. */
  private async extractOperacion(conversationId: string): Promise<string | null> {
    const turns = await this.thread.readRecentTurns(conversationId, THREAD_TURN_LIMIT);
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role !== 'customer') continue;
      // SÓLO el último inbound del cliente: un comprobante de hace tres días, más arriba en el
      // hilo, no es el que se está verificando ahora.
      return extractComprobanteOperacion(turns[i].attachmentFilenames);
    }
    return null;
  }
}

/**
 * Proyección SIN identidad (D9): hora, recaudador, importe y referencias. Ni el id del recibo,
 * ni el `clienteGrId`, ni las observaciones (texto libre cargado por un humano — el lugar más
 * probable donde aparezca un nombre o un teléfono).
 */
function toReceiptFact(r: GrReceipt, hoy: string): ReceiptFact {
  const fecha = fechaDe(r.fechaRecibo);
  return {
    // fix wave W5 — la fecha viaja en el hecho. Sin ella, `hora:'23:55'` de AYER se leía
    // como "hoy a las 23:55": un recibo de otro día presentado como el pago de esta mañana.
    fecha,
    // Fecha ilegible ⇒ se cuenta como HOY: excluirlo del match produciría "no encontramos tu
    // pago" sobre alguien que pagó, que es el peor modo de falla de R1 (D9).
    esDeAyer: fecha.length > 0 && fecha !== hoy,
    hora: horaDe(r.fechaRecibo),
    recaudador: r.recaudador ?? null,
    // `items` es el ÚNICO nodo de GR que representa dinero REALMENTE recibido (fix-wave-2 R1):
    // `aplicaciones` es deuda cancelada y `retenciones` son certificados, nunca efectivo.
    importe: (r.items ?? []).reduce((sum, i) => sum + (i.importe ?? 0), 0),
    referencias: (r.items ?? [])
      .map((i) => i.numeroTransferencia)
      .filter((n): n is string => typeof n === 'string' && n.length > 0),
  };
}

/** "DD-MM-YYYY HH:MM:SS" → "DD-MM-YYYY". `''` si GR no trajo la fecha. */
function fechaDe(fechaRecibo: string | null): string {
  if (!fechaRecibo) return '';
  const [fecha] = fechaRecibo.split(' ');
  return fecha ?? '';
}

/** "DD-MM-YYYY HH:MM:SS" → "HH:MM". La fecha va aparte, en `ReceiptFact.fecha`. */
function horaDe(fechaRecibo: string | null): string {
  if (!fechaRecibo) return '';
  const [, time] = fechaRecibo.split(' ');
  if (!time) return '';
  const [hh, mm] = time.split(':');
  return `${hh}:${mm}`;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + days);
  return out;
}

/** Date → "DD-MM-AAAA" (formato OBLIGATORIO de `action:recibos`; una ISO da HTTP 500). */
function grDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}
