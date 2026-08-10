import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type {
  AssistantDataSourceResolver,
  AssistantSubjectContext,
} from '@domain/ports/AssistantDataSourceRegistry';
import type { RefreshClientBalanceIfStale } from '@application/use-cases/RefreshClientBalanceIfStale';

/**
 * ai-assistant-multiagent — fuente `cliente.saldo`.
 *
 * ⚠️ **La decisión más importante de este archivo: NUNCA emitir un saldo desactualizado.**
 *
 * `Customer.balanceDue` puede estar viejo (`balanceStale`). Decirle a un cliente "debés
 * $45.000" con una cifra de hace tres días es darle un número EQUIVOCADO sobre su propia
 * plata — exactamente el modo de falla que este change existe para evitar. Y a diferencia de
 * una alucinación del modelo, ésta la produciríamos nosotros con datos "reales".
 *
 * customer-balance-unmask — el gate YA NO depende del `status` del cliente (antes de este
 * change, `Customer.balanceStale` salía `false` para todo cliente que no fuera `late`, sin
 * importar la antigüedad real del dato: el guard estaba cortocircuitado en abierto para el
 * 99% de la base). `balanceStale` ahora es status-agnóstico
 * (`isBalanceOlderThanTtl`, spec `balance-staleness-helper`) — el gate es el MISMO para
 * cualquier `CustomerStatus`. Y `balanceDue`/`balanceCurrency` ya no se enmascaran a 0/null
 * según status (spec `customer-balance-truth`): un cliente `active` con deuda real emite el
 * saldo, exactamente como uno `late` siempre pudo.
 *
 * Secuencia: si está stale se intenta refrescar contra Gestión Real; si tras el intento sigue
 * stale (GR caída, cliente sin `grClienteId`, TTL no vencido), se devuelve
 * `disponible:false` con el motivo. El `responseGuide` de la intención decide qué hacer con
 * eso — normalmente derivar a un humano. **Es preferible un handoff a un número mal.**
 *
 * Guard de moneda (spec `assistant-balance-guard`): `balanceCurrency` puede ser `null` en un
 * balance por lo demás confiable (el mapper nunca lo normaliza ni lo default-ea a `'ARS'`) — el
 * resolver NUNCA adivina la moneda; sin ella, deriva a humano igual que con un saldo stale.
 *
 * Proyección EXPLÍCITA campo por campo: `Customer` trae `name`, `email`, `phone`, `address`.
 * Un spread acá sería una fuga directa (la cazaría `assertFactsArePiiFree`, pero el diseño no
 * se apoya en la red de seguridad — se apoya en no acercarse al borde).
 */
export class ClienteSaldoResolver implements AssistantDataSourceResolver {
  readonly key = 'cliente.saldo';

  constructor(
    private readonly customers: CustomerRepository,
    private readonly refreshBalance?: RefreshClientBalanceIfStale,
  ) {}

  async resolve(ctx: AssistantSubjectContext): Promise<Record<string, unknown>> {
    // Conversación sin cliente matcheado (teléfono desconocido): no hay nada que aportar.
    if (!ctx.clientId) return { disponible: false, motivo: 'cliente_no_identificado' };

    let customer = await this.customers.findById(ctx.clientId);

    if (customer.balanceStale && customer.grClienteId && this.refreshBalance) {
      const refreshed = await this.refreshBalance.execute({
        grClienteId: customer.grClienteId,
        lastBalanceAt: customer.lastBalanceAt ?? null,
      });
      if (refreshed) {
        customer = await this.customers.findById(ctx.clientId);
      }
    }

    if (customer.balanceDue === null || customer.balanceDue === undefined) {
      return { disponible: false, motivo: 'saldo_nunca_consultado' };
    }
    if (customer.balanceStale) {
      // Se sabe el número, pero no se confía en él. No se emite.
      return { disponible: false, motivo: 'saldo_desactualizado' };
    }
    // customer-balance-unmask (spec assistant-balance-guard) — un balance confiable
    // (fresco, no-null) con `balanceCurrency` ausente NO es un caso para adivinar
    // 'ARS': el mapper deja la moneda tal como GR la reportó (nunca la normaliza,
    // nunca la default-ea), así que `null` acá es genuinamente "no confirmada".
    // Asumir ARS sería el MISMO modo de falla que este change existe para evitar
    // — un número "real" pero potencialmente equivocado, dicho con seguridad.
    if (customer.balanceCurrency === null || customer.balanceCurrency === undefined) {
      return { disponible: false, motivo: 'moneda_no_confirmada' };
    }

    return {
      disponible: true,
      saldo: customer.balanceDue,
      moneda: customer.balanceCurrency,
      // Derivado, no el crudo: al modelo le sirve la categoría, no el número para comparar.
      tieneDeuda: customer.balanceDue > 0,
      estadoCliente: customer.status,
    };
  }
}
