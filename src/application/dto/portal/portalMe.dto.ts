/**
 * PortalMeDto — customer-portal-api (Fase 4, task 4.1).
 *
 * fix/portal-balance-from-invoices — el saldo se CALCULA sobre `Invoice`
 * (Prominense), NUNCA sobre `Client.balanceDue` (el agregado del sync de GR —
 * ver `GetPortalMe`/`CustomerRepository.getPortalBalanceSummary` para el porque).
 * Los nombres de campo (`balance`/`balanceCurrency`/`lastBalanceAt`) se
 * preservan sin cambios — la app mobile ya los consume — pero su SEMANTICA
 * cambio:
 *
 * - `balance: number` — suma de `Invoice.balance` de las facturas NO pagadas.
 *   `0` significa "al dia" de verdad (coherente con una lista de facturas sin
 *   deuda pendiente), NUNCA "sin datos".
 * - `balance: null` — el cliente no tiene NINGUNA factura espejada todavia.
 *   Genuinamente no sabemos su saldo. Jamas se colapsa a `0`.
 * - `balanceCurrency` — moneda de la factura mas reciente del cliente
 *   (`Invoice.currency`), o `null` si ninguna la tiene.
 * - `lastBalanceAt` — YA NO es "cuando GR nos dio el saldo" (esa fecha
 *   describia un numero que ya no mostramos). Es la frescura del NUMERO
 *   mostrado: `max(createdAt)` de las facturas impagas consideradas, o de
 *   TODAS las facturas si no hay impagas (todas pagadas), o `null` sin
 *   facturas. Nunca una fecha que no corresponda al `balance` mostrado.
 */
export interface PortalMeDto {
  name: string;
  status: string;
  balance: number | null;
  balanceCurrency: string | null;
  lastBalanceAt: string | null;
}
