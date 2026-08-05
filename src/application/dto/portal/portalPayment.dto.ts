import type { PaymentAmountEntry } from '@domain/services/sumarItemsPorMoneda';

/** Una factura que este pago canceló. */
export interface PortalPaymentApplicationDto {
  /**
   * El número que el cliente ve en SU factura (`000080104`), no la identidad
   * compuesta de GR. Si el id no tiene la forma esperada se expone crudo antes que
   * perderlo.
   */
  invoiceNumber: string;
  amount: number;
}

/**
 * Un pago del cliente — contrato PÚBLICO de `/api/portal/payments`.
 *
 * `amounts` es un ARRAY por moneda y nunca un número solo: mezclar pesos con
 * dólares da un total sin sentido económico (misma regla que `balances[]` en `/me`).
 *
 * ⚠️ NO expone las `observaciones` del recibo: son TEXTO LIBRE que escribe un
 * operador interno en GR, nadie auditó qué se escribe ahí, y viajaría verbatim al
 * teléfono del cliente (un "pagó la hija, DNI X" saldría tal cual). Decisión del
 * usuario 2026-08-05. Agregarlo después es ADITIVO y no rompe teléfonos; sacarlo
 * después SÍ los rompería, así que en la duda no va.
 *
 * `appliedTo` es lo que le da valor a esta pantalla: cuando el cliente paga, GR saca
 * la factura de la lista y el espejo la BORRA (replace-all) ⇒ la aplicación del
 * recibo es el ÚNICO rastro de qué factura se canceló.
 */
export interface PortalPaymentDto {
  /** Fecha del recibo, ISO. */
  date: string | null;
  amounts: PaymentAmountEntry[];
  /** Medio de cobro tal como lo reporta GR. */
  method: string | null;
  appliedTo: PortalPaymentApplicationDto[];
}
