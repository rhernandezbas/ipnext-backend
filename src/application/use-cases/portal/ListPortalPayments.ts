import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { PortalPaymentsReader, PortalPaymentReceiptRow } from '@domain/ports/PortalPaymentsReader';
import type { PortalPaymentDto } from '@application/dto/portal/portalPayment.dto';
import type { PaginatedQuery, PaginatedResult } from '@application/dto/pagination';
import { sumarItemsPorMoneda } from '@domain/services/sumarItemsPorMoneda';

/**
 * ListPortalPayments — el historial de pagos del cliente (`portal-payments`).
 *
 * Existe porque **cuando un cliente paga, el pago no dejaba rastro**: GR saca la
 * factura pagada de `cuentas.invoices` y `upsertInvoices` (replace-all) borra la
 * fila. Medido en prod: 2 facturas en estado `pagada` sobre 7.588. La app le
 * mostraba al cliente SOLO lo que debe.
 *
 * La fuente es el RECIBO, no la deducción sobre la factura ausente: que una factura
 * desaparezca de GR no significa "pagada", significa "ya no está pendiente" — pudo
 * ser anulada o cancelada con una nota de crédito. El recibo es evidencia POSITIVA
 * (fecha, importe, medio de pago) y además dice **a qué factura se aplicó**.
 *
 * `clientId` SIEMPRE del token (`req.portalClientId`); el `grClienteId` se DERIVA de
 * esa fila y nunca del request (PAY-1.1).
 */
export class ListPortalPayments {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly payments: PortalPaymentsReader,
  ) {}

  async execute(clientId: string, query: PaginatedQuery): Promise<PaginatedResult<PortalPaymentDto>> {
    const client = await this.customers.findById(clientId);

    // Sin link a GR no hay recibos que traer. Lista vacía —no un error— porque es
    // un estado legítimo (cliente creado en Prominense sin espejar todavía).
    if (!client?.grClienteId) {
      return { data: [], total: 0, page: query.page ?? 1, limit: query.limit ?? 25 };
    }

    const page = await this.payments.listByGrClienteId(client.grClienteId, query);

    return { ...page, data: page.data.map(toPortalPaymentDto) };
  }
}

function toPortalPaymentDto(row: PortalPaymentReceiptRow): PortalPaymentDto {
  return {
    date: row.fechaRecibo,
    // Items + RETENCIONES: la plata que puso el cliente.
    //
    // Los items solos NO alcanzan. Medido contra GR sobre 1.500 recibos reales: los
    // 2 que traen retenciones NO traen items — son 100% retención (el schema lo
    // documenta también: "7 de 18 recibos de junio 2026 con retenciones no traen
    // items"). Con items solos, esos pagos salían con `amounts: []`: el cliente veía
    // "canceló la factura 000014454" y NINGÚN importe.
    //
    // La retención es plata del cliente igual — la retuvo para remitirla a AFIP en
    // vez de dárnosla como cash, y le canceló la deuda lo mismo. Sigue sin usarse
    // `applications` (PAY-1.3): eso es deuda cancelada, no lo que el cliente puso.
    // Por la identidad medida en finanzas son equivalentes
    // (`aplicaciones = items + retenciones`), pero derivarlo de lo que el cliente
    // aportó es lo que hace que el número sea defendible.
    amounts: sumarItemsPorMoneda([
      ...row.items,
      // Sin `moneda` en la tabla: GR la manda (`PES` en las 4 líneas medidas) y la
      // ingesta la descarta. Se atribuye a ARS y queda como deuda documentada.
      ...row.retenciones.map((r) => ({ amount: r.amount, moneda: 'PES' })),
    ]),
    method: row.recaudador,
    appliedTo: row.applications.map((a) => ({
      invoiceNumber: numeroDeFactura(a.grInvoiceId),
      amount: a.amount,
    })),
  };
}

/**
 * `"FB-00010-000080104"` → `"000080104"` — el número que el cliente ve en su factura.
 * Una forma inesperada se expone CRUDA antes que perderla: un id raro en pantalla es
 * mejor que un pago sin referencia.
 */
function numeroDeFactura(grInvoiceId: string): string {
  const partes = grInvoiceId.split('-');
  const numero = partes.length === 3 ? partes[2] : '';
  // El `|| grInvoiceId` NO es decorativo: la ingesta hace `numero: a.numero ?? ''`
  // (o sea YA asume que GR puede mandarlo null), así que `grInvoiceId` puede ser
  // `"FB-00010-"` — tres partes, la última VACÍA. Sin esto el cliente veía un pago
  // aplicado a una factura sin número. El docstring prometía exponer la forma cruda
  // antes que perderla y para ese caso era falso.
  return numero || grInvoiceId;
}
