import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type {
  AssistantDataSourceResolver,
  AssistantSubjectContext,
} from '@domain/ports/AssistantDataSourceRegistry';
import type { RefreshClientBalanceIfStale } from '@application/use-cases/RefreshClientBalanceIfStale';
import { motivoNoDisponible, GUIA_SALDO_A_FAVOR } from './assistantMotivoGuia';

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
 * **Pero sólo cuando hay un monto POSITIVO que denominar** (fix wave F1): la escritura real
 * sintetiza `currency = amount > 0 ? 'ARS' : null`, así que "moneda null" es, en los hechos,
 * el cliente AL DÍA. Un guard incondicional convertía el carril feliz en un handoff masivo.
 * Y en esa rama el monto NO se emite (fix wave 2, FW2-1): `saldo: 0` fijo. Un crédito llega
 * sin moneda, el signo no sobrevive al prompt, y el monto crudo whitelistearía su propia
 * cifra en el verificador de números — "deuda de 5000" sobre plata a favor, verificada.
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
    if (!ctx.clientId) return motivoNoDisponible('cliente_no_identificado');

    let customer = await this.customers.findById(ctx.clientId);

    if (customer.balanceStale && customer.grClienteId && this.refreshBalance) {
      const refreshed = await this.refreshBalance.execute({
        grClienteId: customer.grClienteId,
        lastBalanceAt: customer.lastBalanceAt ?? null,
        // fix wave 2 (FW2-3) — el CUARTO call site del refresh. F7 cableó el
        // status en la ficha y en el inbox y se olvidó de éste: el bot pedía el
        // refresh sin carril ⇒ TTL rápido para todos, incluidas las bajas.
        // Hoy sería inerte por accidente (el `if` de arriba exige el
        // `balanceStale` del mapper, que YA es por carril), pero eso es apoyarse
        // en que dos gates independientes coincidan para siempre.
        status: customer.status,
      });
      if (refreshed) {
        customer = await this.customers.findById(ctx.clientId);
      }
    }

    if (customer.balanceDue === null || customer.balanceDue === undefined) {
      return motivoNoDisponible('saldo_nunca_consultado');
    }
    if (customer.balanceStale) {
      // Se sabe el número, pero no se confía en él. No se emite.
      return motivoNoDisponible('saldo_desactualizado');
    }

    // fix wave F1 — **la moneda sólo se exige cuando hay un monto POSITIVO que
    // denominar.** El guard original la exigía siempre, y eso lo volvía un
    // apagón: la escritura real sintetiza la moneda como
    // `amount > 0 ? 'ARS' : null` (`parseClientBalanceResponse`), así que
    // `balanceCurrency === null` ⟺ **el cliente no debe nada**. Exigirla en ese
    // caso derivaba a un humano a TODO cliente al día (~2.300 del carril
    // rápido) para responderle "estás al día" — la respuesta que ya teníamos.
    //
    // "$0" no necesita moneda: cero pesos y cero dólares son el mismo hecho, y
    // el hecho que el bot emite es `tieneDeuda:false`, no una cifra a cobrar.
    //
    // fix wave 2 (FW2-1) — **el monto <= 0 NO viaja crudo.** La rama emitía
    // `saldo: customer.balanceDue`, así que un crédito salía como `saldo: -5000`
    // con `moneda: null`. Dos cosas se pierden en el camino al prompt: el signo
    // (el modelo lee "5000" a secas) y la moneda (que en un crédito es SIEMPRE
    // null por construcción del parser). Y no queda ni la última red: el
    // verificador de números recorre los hechos para armar su whitelist, así que
    // `-5000` **autoriza** la cadena "5000" — "tenés una deuda de 5000" pasaba
    // verificada, sobre un cliente que tiene esa plata A FAVOR.
    //
    // El hecho que el bot necesita acá es `tieneDeuda:false`, no una cifra. El
    // `saldo: 0` es literal y suficiente: no debe nada. El crédito lo confirma un
    // humano (ver `GUIA_SALDO_A_FAVOR`).
    if (customer.balanceDue <= 0) {
      return {
        disponible: true,
        saldo: 0,
        // No hay monto que denominar: null siempre, nunca un 'ARS' heredado.
        moneda: null,
        tieneDeuda: false,
        estadoCliente: customer.status,
        // Sólo el crédito lleva guía: es el único caso donde queda algo sin
        // responder ("¿cuánto tengo a favor?") y el bot no lo puede decir.
        ...(customer.balanceDue < 0 ? { guia: GUIA_SALDO_A_FAVOR } : {}),
      };
    }

    // customer-balance-unmask (spec assistant-balance-guard) — acá SÍ hay un monto
    // positivo que el bot va a EMITIR, y una cifra sin moneda es una cifra
    // ambigua sobre la plata de alguien. El mapper deja la moneda tal como quedó
    // escrita (nunca la normaliza, nunca la default-ea), así que `null` sobre un
    // monto positivo es genuinamente "no confirmada" — una fila legacy o una
    // moneda futura no-ARS. Asumir ARS sería el MISMO modo de falla que este
    // change existe para evitar: un número "real" pero equivocado, dicho con
    // seguridad.
    if (customer.balanceCurrency === null || customer.balanceCurrency === undefined) {
      return motivoNoDisponible('moneda_no_confirmada');
    }

    return {
      disponible: true,
      saldo: customer.balanceDue,
      moneda: customer.balanceCurrency,
      // Derivado, no el crudo: al modelo le sirve la categoría, no el número para comparar.
      tieneDeuda: true,
      estadoCliente: customer.status,
    };
  }
}
