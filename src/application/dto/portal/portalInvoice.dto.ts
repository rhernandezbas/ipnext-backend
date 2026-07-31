/**
 * PortalInvoiceDto — customer-portal-api (Fase 4, task 4.2).
 *
 * portal-self-service spec "Mis facturas": allow-list exacto del spec. NUNCA
 * `lineItems`/`grInvoiceId`/campos internos de `Invoice` (domain/entities/billing.ts).
 *
 * fix (moneda ausente del contrato) — sin `currency`, la app formatea TODA
 * factura como pesos (`Intl.NumberFormat` sin código = default ARS): una
 * factura en `DOL` se mostraba como si fueran pesos. Medido en prod:
 * `Invoice.currency` trae `PES` (7430 filas) / `DOL` (43 filas) — códigos de
 * GR, no ISO 4217 — y hay clientes con facturas en ambas monedas. Mismo bug
 * ya arreglado en `/me` (`PortalBalanceSummary`); acá se resuelve igual, vía
 * `normalizeGrCurrency` (dominio puro, `@domain/services/normalizeGrCurrency`).
 *
 * Decisión sobre `Invoice.currency = null` en la fila (`toPortalInvoiceDto`
 * en `ListPortalInvoices.ts`): se etiqueta `'DESCONOCIDA'`, NUNCA se asume
 * `ARS`. Difiere a propósito de `toPortalBalanceSummary`, que sí asume `ARS`
 * cuando `null` es la ÚNICA moneda con deuda del cliente — esa asunción se
 * apoya en comparar TODAS las facturas impagas del cliente entre sí (si no
 * hay ninguna otra moneda real con la que confundirse, ARS es un fallback
 * razonable). Acá el mapeo es POR FACTURA, sin ese contexto de grupo: además,
 * `Invoice.currency = null` no es solo un caso defensivo raro — es el valor
 * ESPERADO para facturas manuales (no-GR, ver `grInvoiceId`/`currency` en
 * `domain/entities/billing.ts`), una categoría real y recurrente, no un
 * edge case teórico. Adivinar `ARS` ahí, fila por fila, reproduciría
 * exactamente el bug que se está arreglando (una factura en una moneda que
 * no es pesos, mostrada como pesos) — con el agravante de que acá no hay
 * comparación posible que lo descarte. `'DESCONOCIDA'` es honesto: le dice a
 * la app "no sabemos", en vez de mentir con un signo `$`.
 */
export interface PortalInvoiceDto {
  number: string;
  issueDate: string;
  dueDate: string;
  amount: number;
  balance: number | null;
  status: string;
  /** ISO 4217 normalizado (`normalizeGrCurrency`), o `'DESCONOCIDA'` si
   *  `Invoice.currency` viene ausente en esta factura (ver docstring arriba). */
  currency: string;
  pdfUrl: string | null;
  paymentUrl: string | null;
}
