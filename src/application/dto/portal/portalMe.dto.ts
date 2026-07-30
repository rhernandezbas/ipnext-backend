/**
 * PortalMeDto — customer-portal-api (Fase 4, task 4.1).
 *
 * fix/portal-balance-from-invoices — el saldo se CALCULA sobre `Invoice`
 * (Prominense), NUNCA sobre `Client.balanceDue` (el agregado del sync de GR —
 * ver `GetPortalMe`/`CustomerRepository.getPortalBalanceSummary` para el porque).
 *
 * fix wave (multi-moneda) — `balance`/`balanceCurrency` (un único número)
 * SE ELIMINARON: medido en prod, `Invoice.currency` tiene facturas impagas en
 * `PES` (`ARS`) Y `DOL` (`USD`) para el mismo cliente (4 clientes con
 * facturas en 2 monedas, 3 de ellos con IMPAGAS en 2 monedas) — sumarlas en
 * un solo `balance` mezclaba pesos con dólares (basura), y exponer el código
 * crudo de GR (`PES`) rompía el formateo de la app (`Intl.NumberFormat`
 * mostraría "PES 127.561,28" en vez de "$ 127.561,28"). `balances` reemplaza
 * a ambos campos con una entrada POR MONEDA ISO 4217 real.
 *
 * - `balances: PortalBalanceEntryDto[]` — una entrada por moneda con deuda,
 *   ordenadas por `amount` DESC. Monedas DISTINTAS jamás se suman entre sí.
 *   `[{ currency, amount: 0 }]` (una sola entrada) significa "al día" de
 *   verdad — el cliente tiene facturas y TODAS están pagadas.
 * - `balances: null` — el cliente no tiene NINGUNA factura espejada todavía.
 *   Genuinamente no sabemos su saldo. Jamás se colapsa a `[]` ni a `0`.
 * - `lastBalanceAt` — frescura del dato mostrado (`max(createdAt)` de las
 *   facturas impagas consideradas, de CUALQUIER moneda, o de TODAS las
 *   facturas si no hay impagas, o `null` sin facturas). Nunca una fecha que
 *   no corresponda al `balances` mostrado.
 */
export interface PortalBalanceEntryDto {
  /** ISO 4217 normalizado (nunca el código crudo de GR: `PES`/`DOL`). */
  currency: string;
  /** Saldo impago en ESTA moneda únicamente. */
  amount: number;
}

export interface PortalMeDto {
  name: string;
  status: string;
  balances: PortalBalanceEntryDto[] | null;
  lastBalanceAt: string | null;
}
