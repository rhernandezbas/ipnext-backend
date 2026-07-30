/**
 * normalizeGrCurrency — fix/portal-balance-from-invoices.
 *
 * Dominio puro. `Invoice.currency` guarda el código de moneda TAL COMO lo
 * manda GR — medido en prod: `PES` (7430 filas) y `DOL` (43 filas), NINGUNO
 * de los dos es ISO 4217 real. El consumidor (app mobile) formatea el saldo
 * con `Intl.NumberFormat`, que espera un código ISO — sin normalizar,
 * mostraría literalmente "PES 127.561,28" en vez de "$ 127.561,28".
 *
 * - `PES` → `ARS`, `DOL` → `USD` (case-insensitive, trim).
 * - Código desconocido (ni `PES` ni `DOL` — ej. una moneda nueva que GR
 *   empiece a mandar mañana) ⇒ se devuelve TAL CUAL, en mayúsculas. Regla
 *   "basura al valor seguro": JAMÁS se asume `ARS` para un código
 *   desconocido — asumir mentiría sobre el tipo de cambio real de esa
 *   factura (una deuda en una moneda fuerte se mostraría como si fueran
 *   pesos, subestimándola).
 * - `null` / `undefined` / string vacío (tras `trim`) ⇒ devuelve `null`.
 *   Decisión: NO default a `ARS` acá — un `Invoice.currency` ausente es "no
 *   sabemos", no "es pesos". Esta función NO decide qué hacer con esa
 *   ausencia: es responsabilidad del LLAMADOR, que tiene contexto que esta
 *   función pura no tiene (qué otras monedas tiene el mismo cliente). El
 *   agrupador (`PrismaCustomerRepository.toPortalBalanceSummary`) es el
 *   único llamador real hoy: si `null` es la ÚNICA moneda con deuda del
 *   cliente, asume `ARS` (no hay otra moneda real con la que pueda
 *   confundirse, y en prod jamás se vio `currency = null` — es un fallback
 *   defensivo, no un camino medido); si coexiste con monedas conocidas,
 *   la etiqueta como `'DESCONOCIDA'` en vez de fusionarla con una moneda
 *   real (fusionarla mentiría sobre el total de esa moneda).
 */
export function normalizeGrCurrency(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const upper = trimmed.toUpperCase();
  if (upper === 'PES') return 'ARS';
  if (upper === 'DOL') return 'USD';
  return upper;
}
