/**
 * PortalMeDto — customer-portal-api (Fase 4, task 4.1).
 *
 * portal-self-service spec "Mi resumen": `balance: null` (Client.balanceDue sin
 * fetch de GR aun) es DISTINTO de `balance: 0` (deuda cero) — el mapeo desde
 * `Customer.balanceDue` (number | null | undefined) preserva null explicitamente,
 * NUNCA lo colapsa a 0.
 */
export interface PortalMeDto {
  name: string;
  status: string;
  balance: number | null;
  balanceCurrency: string | null;
  lastBalanceAt: string | null;
}
