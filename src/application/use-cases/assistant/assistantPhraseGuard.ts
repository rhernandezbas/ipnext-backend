/**
 * ai-assistant-cobranzas (fix wave C5, corregido en N2) — verificador de FRASE, hermano de
 * SEC-4.
 *
 * SEC-4 (`assistantNumberVerifier`) sólo mira NÚMEROS: una respuesta como "Estás al día, no
 * tenés facturas pendientes" no contiene ni un dígito y pasa entera, aunque el cliente deba
 * $72.589. Y como el bloque determinístico se CONCATENA al texto del modelo, el mensaje que
 * sale puede ser literalmente "Estás al día. / Recibimos tu pago. Te quedan $72.589,41
 * pendientes." — el peor mensaje posible: contradictorio y tranquilizador.
 *
 * Hasta este fix, el único freno era el `responseGuide` (o sea, el prompt: una sugerencia).
 * Acá es CÓDIGO: si el texto generado contradice el signo del saldo de la MISMA corrida, se
 * descarta el texto del modelo y queda sólo lo determinístico (o handoff si no hay nada).
 *
 * ⚠️ **N2 — el guard es consciente de la NEGACIÓN, no sólo de la dirección.** La primera
 * versión marcaba cualquier aparición de "pendiente" con `debt <= 0`, y con eso descartaba la
 * respuesta CANÓNICA del cliente al día: *"No tenés facturas pendientes, estás al día"*. Un
 * falso positivo acá no es cosmético — manda a un humano el carril entero de clientes sin
 * deuda, que es justo el que la fix wave F1 peleó por conservar. Por eso primero se BORRAN las
 * cláusulas negadas y recién después se buscan afirmaciones.
 *
 * Función PURA. No decide qué se envía — sólo responde "¿esto contradice los hechos?".
 */

/**
 * Cláusula NEGADA que afirma que NO se debe nada ("no tenés deuda", "no debés nada", "no hay
 * facturas vencidas"). El corte por `,`/`;`/`.` es deliberado: la negación tapa su propia
 * cláusula, NUNCA la oración siguiente — si no, "No tenés problemas de conexión, pero debés
 * $5.000" pasaría entero.
 */
const SIN_DEUDA_NEGADO = /\bno\s+(te\s+)?(ten[eé]s|hay|debe[sn]?|deb[eé]s|quedan?|registra\w*|figura\w*)\b[^.,;]{0,40}/gi;

/** Afirmaciones POSITIVAS de deuda. Ilegales cuando `debt <= 0`. */
const DEUDA_AFIRMADA: RegExp[] = [
  /\b(ten[eé]s|quedan?|te\s+queda\w*|registra\w*|figura\w*)\b[^.,;]{0,40}\b(deuda|pendiente|vencid|impag|saldo)/i,
  // "debés" a secas alcanza; "debés nada" ya lo saca la limpieza de negaciones, pero el
  // lookahead lo cubre también cuando la negación viene lejos ("nunca debés nada").
  /\bdeb[eé]s\b(?!\s+nada)/i,
];

/**
 * Cláusula NEGADA que afirma que TODAVÍA NO está al día ("todavía no estás al día", "no
 * quedaste al día"). Es verdad cuando `debt > 0`, así que no puede marcarse.
 */
const AL_DIA_NEGADO = /\bno\s+[^.,;]{0,20}al d[ií]a/gi;

/** Afirmaciones de "no debe nada". Ilegales cuando `debt > 0`. */
const AL_DIA_AFIRMADO: RegExp[] = [
  /al d[ií]a/i,
  /\bno\s+(te\s+)?(ten[eé]s|hay|quedan?|registra\w*|figura\w*)\b[^.,;]{0,40}\b(deuda|pendiente|vencid|impag)/i,
  /sin deuda|libre de deuda/i,
];

/** Borra las cláusulas negadas para que no disparen los patrones afirmativos. */
function stripNegated(text: string, negated: RegExp): string {
  return text.replace(negated, ' ');
}

/**
 * `true` si `text` afirma lo CONTRARIO a lo que dice `debt`.
 *
 * `debt === null` (saldo no disponible en la corrida) ⇒ `false`: sin hecho contra el cual
 * contrastar, esta guarda no opina — de esa rama se ocupa RSP-1 ("no afirmar ninguno de los
 * dos estados"), que vive en el `responseGuide` y en el bloque determinístico ausente.
 */
export function contradictsBalanceState(text: string, debt: number | null): boolean {
  if (debt === null || !Number.isFinite(debt)) return false;
  if (typeof text !== 'string' || text.trim().length === 0) return false;

  if (debt > 0) {
    // Debe plata: lo prohibido es decir que NO debe. "Todavía no estás al día" es verdad.
    const limpio = stripNegated(text, AL_DIA_NEGADO);
    return AL_DIA_AFIRMADO.some((re) => re.test(limpio));
  }

  // Al día (o a favor): lo prohibido es AFIRMAR una deuda. Las negaciones ("no tenés facturas
  // pendientes") son exactamente la respuesta correcta.
  const limpio = stripNegated(text, SIN_DEUDA_NEGADO);
  return DEUDA_AFIRMADA.some((re) => re.test(limpio));
}
