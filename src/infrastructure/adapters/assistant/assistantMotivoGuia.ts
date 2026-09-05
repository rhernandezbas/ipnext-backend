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
  | 'moneda_no_confirmada'
  // ai-assistant-cobranzas (4.2 / DAT-1 / D7-D8) — el espejo de facturas no es confiable en
  // esta corrida (sigue stale tras el intento de refresh, o el cliente no está espejado).
  | 'facturas_no_disponibles'
  // ai-assistant-cobranzas (4.9 / D9) — GR no respondió la consulta de recibos de hoy.
  | 'recibos_no_disponibles';

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
  // ai-assistant-cobranzas (DAT-1) — ⚠️ la trampa de este motivo es la INVERSA de los de
  // saldo: no es sólo "no digas un número", es **no digas que esta al dia**. Una lista de
  // facturas vacía o no confiable NO prueba que el cliente no deba nada (D7/DFT-2:
  // `cliente.saldo` es la única fuente autorizada para eso). Sin esta frase explícita, el
  // modelo lee "no hay facturas" y concluye lo más amable, que es justo lo peor.
  facturas_no_disponibles:
    'No tenemos confirmado el detalle de facturas en esta consulta. NO concluyas que esta al dia por no ver facturas: eso solo lo define el saldo. Si pide el detalle, decile que un asesor se lo pasa enseguida. No menciones ningun importe.',
  // ai-assistant-cobranzas (D9) — GR caído NO es "no vemos tu pago". Mandar a Administración
  // a alguien que SÍ pagó (con el comprobante en la mano) es el peor modo de falla de R1.
  recibos_no_disponibles:
    'No pudimos verificar los pagos del dia contra el sistema. NO le digas que no vemos su pago ni que no figura: no lo pudimos consultar. Decile que un asesor lo verifica enseguida. No menciones ningun importe.',
};

/**
 * fix wave 2 (FW2-1) — guía para el `disponible:true` del SALDO A FAVOR.
 *
 * No es un motivo (el hecho SÍ está disponible: "no debe nada"), pero necesita
 * copy propio por la misma razón que los motivos: el monto del crédito **no se
 * emite** —llega sin moneda (`amount > 0 ? 'ARS' : null`), y un número sin
 * denominar sobre la plata de alguien es justo lo que este change existe para no
 * decir—, así que el modelo se queda con `tieneDeuda:false` y sin nada que
 * responder si el cliente pregunta "¿cuánto tengo a favor?". Sin guía improvisa,
 * y lo único que tiene a mano para improvisar es el hilo.
 *
 * ⚠️ **Sin dígitos, a propósito.** Todo texto que viaje en los hechos lo recorre
 * `buildNumberWhitelist` y sus cifras quedan RESPALDADAS: meter un número acá
 * sería reabrir por la puerta de al lado el agujero que FW2-1 cierra.
 */
export const GUIA_SALDO_A_FAVOR =
  'El cliente no tiene deuda: tiene saldo a favor. Decile que esta al dia. Si pregunta cuanto tiene a favor, decile que un asesor se lo confirma. No menciones ningun importe.';

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
