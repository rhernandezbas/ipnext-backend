/**
 * fix wave F5 — **el `motivo` no viaja solo al prompt.**
 *
 * Los resolvers devolvían `{disponible:false, motivo:'saldo_desactualizado'}` y
 * ahí terminaba nuestra participación: el modelo recibía un identificador
 * interno, en snake_case, sin ninguna indicación de qué hacer con él, e
 * improvisaba. "saldo_desactualizado" es perfectamente legible para nosotros y
 * perfectamente ambiguo para un LLM: puede leerlo como "el sistema falló", como
 * "el cliente no pagó", o —lo peor— citar igual el número que cree recordar del
 * hilo.
 *
 * Un `disponible:false` no es un error técnico: es **una decisión de producto
 * sobre qué se le dice al cliente**. Esa decisión la tomamos nosotros, en
 * castellano, acá — no el modelo, cada vez, a su criterio.
 *
 * Regla dura de todas las guías: **ninguna habilita citar un importe.** El
 * `disponible:false` existe justamente porque no hay número confiable que decir.
 */

/** Todos los motivos que cualquier resolver puede emitir. Ampliarlo obliga a escribir su guía. */
export type AssistantMotivo =
  | 'cliente_no_identificado'
  | 'saldo_nunca_consultado'
  | 'saldo_desactualizado'
  | 'moneda_no_confirmada';

/**
 * Copy EXACTO que el bot debe seguir para cada motivo.
 *
 * El tipo `Record<AssistantMotivo, string>` es la mitad del guard: agregar un
 * motivo al union sin su guía no compila. La otra mitad es el test que escanea
 * el fuente de los resolvers buscando `motivo:` literales que no estén acá —
 * porque el compilador no puede ver un motivo inventado inline como string.
 */
export const MOTIVO_GUIA: Record<AssistantMotivo, string> = {
  cliente_no_identificado:
    'No pudimos identificar al cliente por este numero. Pedile que confirme su numero de cliente para poder ayudarlo. No des ningun dato de cuenta.',
  saldo_nunca_consultado:
    'No tenemos un saldo confirmado para este cliente. Decile que un asesor le confirma el saldo enseguida. No menciones ningun importe.',
  saldo_desactualizado:
    'El saldo que figura puede estar desactualizado y no lo podemos confirmar ahora. Decile que un asesor le confirma el saldo enseguida. No menciones ningun importe.',
  moneda_no_confirmada:
    'Tenemos un importe pero no la moneda confirmada, asi que no se puede informar. Decile que un asesor le confirma el saldo enseguida. No menciones ningun importe.',
};

/**
 * Construye el hecho "no disponible" COMPLETO: motivo + guía, siempre juntos.
 *
 * Que sea una función y no un objeto suelto es a propósito: un `return
 * {disponible:false, motivo:'...'}` escrito a mano vuelve a dejar al modelo sin
 * guía, y es exactamente lo que pasó. Acá no se puede olvidar.
 *
 * ⚠️ Sobre `assertFactsArePiiFree`: la guía es una CONSTANTE nuestra, sin datos
 * del cliente. En el caso patológico de que el nombre real de un cliente fuera
 * una palabra suelta que aparece en el texto, la barrera de PII saltaría y el
 * motor degrada a no-op (RUN-1) — molesto, pero falla hacia el lado seguro.
 */
export function motivoNoDisponible(motivo: AssistantMotivo): Record<string, unknown> {
  return { disponible: false, motivo, guia: MOTIVO_GUIA[motivo] };
}
