import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type {
  AssistantDataSourceResolver,
  AssistantSubjectContext,
} from '@domain/ports/AssistantDataSourceRegistry';
import type { AssistantInvoicesReader } from '@domain/ports/AssistantInvoicesReader';
import type { RefreshClientBalanceIfStale } from '@application/use-cases/RefreshClientBalanceIfStale';
import { motivoNoDisponible } from './assistantMotivoGuia';

/**
 * ai-assistant-cobranzas (4.3 / DAT-1 / D7-D8) — fuente `cliente.facturas`.
 *
 * Molde `ClienteSaldoResolver`, y por la misma razón: **el peor modo de falla no es no
 * contestar, es contestar con un dato viejo o con una conclusión que los datos no sostienen.**
 * Acá hay DOS de esas, no una:
 *
 *  1. **Factura vieja.** El espejo de facturas se refresca por el MISMO camino que el saldo
 *     (`RefreshClientBalanceIfStale` → `updateBalanceAndInvoices`, D8: un solo payload de GR,
 *     una sola transacción). Si tras intentar el refresh el balance sigue `stale`, las
 *     facturas del espejo son tan poco confiables como el saldo: se emite el motivo, no la
 *     lista. Citar el número y el link de pago de una factura que el cliente ya pagó es peor
 *     que no contestar.
 *
 *  2. **"Estás al día" por lista vacía.** Ésta es la trampa propia de esta fuente. Una lista
 *     vacía puede significar "no debe nada" o "el espejo no tiene sus facturas", y desde acá
 *     no se distinguen. `cliente.saldo` es la ÚNICA fuente autorizada para afirmar que no hay
 *     deuda (D7/DFT-2), así que este resolver NUNCA emite un hecho que se pueda leer como
 *     al-día: emite `facturas_no_disponibles` y deja que la guía derive (D7 textual).
 *
 * ⚠️ **El colaborador de refresh DEBE ser la MISMA instancia que usa `cliente.saldo`** (D8, pin
 * de composición 6.1): es un single-flight con TTL por carril. Dos instancias = dos vuelos a
 * GR en la misma corrida, y un saldo y unas facturas que pueden venir de payloads distintos —
 * exactamente la divergencia que D8 existe para cerrar.
 */
export class ClienteFacturasResolver implements AssistantDataSourceResolver {
  readonly key = 'cliente.facturas';

  constructor(
    private readonly customers: CustomerRepository,
    private readonly invoices: AssistantInvoicesReader,
    private readonly refreshBalance?: RefreshClientBalanceIfStale,
    /**
     * ai-assistant-cobranzas (fix wave W9 / REN-1) — alias de pago por el que corresponde
     * transferir, si la operación ofrece uno. Vacío/ausente ⇒ el bloque determinístico no
     * menciona ningún alias: un alias equivocado en un mensaje de cobranza manda la plata del
     * cliente a otra cuenta, así que acá el default seguro es el silencio, no una constante.
     */
    private readonly payAlias?: string | null,
  ) {}

  async resolve(ctx: AssistantSubjectContext): Promise<Record<string, unknown>> {
    if (!ctx.clientId) return motivoNoDisponible('cliente_no_identificado');

    let customer = await this.customers.findById(ctx.clientId);

    if (customer.balanceStale && customer.grClienteId && this.refreshBalance) {
      const refreshed = await this.refreshBalance.execute({
        grClienteId: customer.grClienteId,
        lastBalanceAt: customer.lastBalanceAt ?? null,
        // El carril del status, igual que `ClienteSaldoResolver` (FW2-3): pedir el refresh
        // sin carril le da TTL rápido a todos, bajas incluidas.
        status: customer.status,
      });
      if (refreshed) {
        customer = await this.customers.findById(ctx.clientId);
      }
    }

    // Sigue stale ⇒ el espejo de facturas salió de la misma escritura que el saldo que no
    // confiamos. No hay factura "parcialmente confiable".
    if (customer.balanceStale) return motivoNoDisponible('facturas_no_disponibles');

    const facturas = await this.invoices.listOpenByClientId(ctx.clientId);
    // D7 textual — lista vacía NUNCA se emite como hecho: sería una invitación a concluir
    // "no debe nada" desde una fuente que no tiene autoridad para decirlo.
    if (facturas.length === 0) return motivoNoDisponible('facturas_no_disponibles');

    return {
      disponible: true,
      cantidad: facturas.length,
      facturas,
      // D8 — "pagar todo junto". `null` es perfectamente válido: GR no siempre lo trae, y el
      // bloque determinístico (`renderInvoiceBlock`) simplemente omite esa línea.
      linkPagoTotal: await this.invoices.findTotalPaymentUrlByClientId(ctx.clientId),
      // REN-1 — con alias configurado, el bloque agrega la aclaración de titularidad.
      ...(this.payAlias && this.payAlias.trim().length > 0 ? { aliasPago: this.payAlias.trim() } : {}),
    };
  }
}
