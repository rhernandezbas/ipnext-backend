/**
 * Paginación declarada ACÁ y no importada de `@application/dto/pagination`.
 *
 * El dominio no puede depender de la capa de arriba: importarla rompe el DIP y el
 * test de arquitectura `domainLayerPurity` lo caza (así se descubrió). Son tipos
 * estructurales, así que el use case sigue devolviendo el `PaginatedResult` de
 * application sin conversión ni casteo.
 */
export interface PortalPaymentsQuery {
  page?: number;
  limit?: number;
}

export interface PortalPaymentsPage<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/** Una aplicación del recibo: qué factura canceló y por cuánto. */
export interface PortalPaymentApplicationRow {
  /** Identidad compuesta de GR: `{tipo}-{sucursal}-{numero}`. */
  grInvoiceId: string;
  grType: string;
  amount: number;
}

/** Un recibo del cliente, con lo mínimo que el portal necesita mostrar. */
export interface PortalPaymentReceiptRow {
  grReceiptId: string;
  /** ISO. Null si GR no la trajo. */
  fechaRecibo: string | null;
  /** El recaudador de GR: `mercadopago`, `cobro_digital`, … */
  recaudador: string | null;
  /** Líneas de cobro: el dinero que EFECTIVAMENTE entró como cash. */
  items: Array<{ amount: number; moneda: string | null }>;
  /**
   * Retenciones impositivas: plata del cliente que NO entró como cash porque la
   * retuvo para remitirla a AFIP — pero canceló su deuda igual.
   *
   * Sin `moneda`: la columna no existe en `FinanceReceiptRetencion` (GR la manda y
   * la ingesta la descarta). Medido en 1.500 recibos reales: las 4 líneas de
   * retención encontradas vinieron `PES`. Ver la card de deuda.
   */
  retenciones: Array<{ amount: number }>;
  applications: PortalPaymentApplicationRow[];
}

/**
 * Lectura de recibos para el PORTAL del cliente.
 *
 * Puerto propio y separado de `FinancePaymentReceiptRepository`, que es de
 * ESCRITURA (`upsertBatch`/`exists`) y lo consume la ingesta. Mezclarlos daría un
 * puerto con dos públicos y dos razones de cambio; mismo criterio que
 * `PrismaClientMirrorReadRepository`.
 *
 * **El anclaje por cliente es del PUERTO, no del caller**: la implementación DEBE
 * filtrar por `grClienteId` y excluir los anulados en su propio WHERE — el servidor
 * es la autoridad, no el use case (ver PAY-2.1 y la lección
 * `invariante-sin-test-en-el-adapter-real`).
 */
export interface PortalPaymentsReader {
  listByGrClienteId(
    grClienteId: string,
    query: PortalPaymentsQuery,
  ): Promise<PortalPaymentsPage<PortalPaymentReceiptRow>>;
}
