/**
 * ai-assistant-cobranzas (2.3 / DAT-2 / D8) — hechos de facturas para la fuente
 * `cliente.facturas`.
 *
 * Una factura, proyectada SÓLO con lo que el bot puede citar. `saldo` es el saldo pendiente
 * de ESTA factura (no el total del cliente — ese vive en `cliente.saldo` /
 * `Client.grPaymentUrl`, D8). `pdfUrl`/`couponPdfUrl`/`paymentUrl` pueden ser `null`: GR no
 * siempre los trae, y una factura sin link de pago propio igual es información válida.
 */
export interface AssistantInvoiceFact {
  tipo: string;
  numero: string;
  /** ISO date. */
  vencimiento: string;
  saldo: number;
  pdfUrl: string | null;
  couponPdfUrl: string | null;
  paymentUrl: string | null;
}

/**
 * Puerto ANGOSTO y anclado al CLIENTE (precedente `PortalPaymentsReader`) — a propósito
 * distinto de `BillingRepository.listInvoices` (query admin, paginada, sin filtro por
 * cliente, que arrastra PII). El SELECT de la implementación MUST NOT proyectar
 * `customerName` ni ningún campo de identidad (DAT-2): el anclaje por cliente es
 * responsabilidad del PUERTO, no del caller.
 *
 * No decide "está al día" ni resuelve staleness — eso es del resolver
 * (`ClienteFacturasResolver`, molde `ClienteSaldoResolver`, D7/D8): este puerto sólo lee el
 * espejo, ya refrescado por quien lo llama.
 */
export interface AssistantInvoicesReader {
  listOpenByClientId(clientId: string): Promise<AssistantInvoiceFact[]>;
  /**
   * ai-assistant-cobranzas (4.3 / D8) — link "pagar TODO junto" (`Client.grPaymentUrl`,
   * escrito en la misma transacción que saldo+facturas, DAT-3). `null` si GR no lo trajo.
   *
   * Vive en ESTE puerto, y no en `CustomerRepository`, por la misma razón que
   * `listOpenByClientId`: es un dato de cobranza anclado al cliente, con la misma proyección
   * sin identidad. Sacarlo de la ficha completa del cliente obligaría al resolver a cargar
   * (y por lo tanto a poder filtrar) nombre, mail, teléfono y dirección — SEC-1 al revés.
   */
  findTotalPaymentUrlByClientId(clientId: string): Promise<string | null>;
}
