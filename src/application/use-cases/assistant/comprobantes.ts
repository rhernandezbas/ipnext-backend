/**
 * ai-assistant-cobranzas (3.5/3.6 / D9/D11 / DAT-4/INT-2) — funciones puras del selector de
 * comprobantes. Sin repos, sin modelo: `matchOperacion` y `posibleDoblePago` los calcula
 * CÓDIGO, nunca el modelo (D9).
 */

/**
 * Un recibo de `cliente.recibos_hoy`, ya proyectado sin PII por el resolver (Lote D3). El
 * ancla es sólo lo que estas funciones necesitan — no la entidad `GrReceipt` completa.
 */
export interface ReceiptFact {
  /**
   * ai-assistant-cobranzas (fix wave W5) — "DD-MM-AAAA" del recibo. La ventana de consulta es
   * HOY−1: sin la fecha, un recibo de ayer se presentaba como el pago de hoy.
   */
  fecha?: string;
  /** fix wave W5 — `true` si el recibo NO es de hoy: viaja como contexto, no como verificación. */
  esDeAyer?: boolean;
  hora: string;
  recaudador: string | null;
  importe: number;
  referencias: string[];
}

export interface MatchOperacionResult {
  operacion: string | null;
  encontrado: boolean;
  importe?: number;
}

/** Mínimo de dígitos para considerar un número de operación real, no basura (D9). */
const MIN_OPERACION_DIGITS = 6;

const COMPROBANTE_FILENAME_PATTERN = /comprobante[_-]?(\d{6,})\.(pdf|jpe?g|png)$/i;

/**
 * Extrae el número de operación de un adjunto `comprobante_<op>.(pdf|jpg|jpeg|png)`. El
 * primer filename que matchea gana. `null` si ninguno matchea (extensión no soportada, menos
 * de 6 dígitos, o no es un archivo `comprobante_*`).
 */
export function extractComprobanteOperacion(filenames: string[]): string | null {
  for (const filename of filenames) {
    const match = COMPROBANTE_FILENAME_PATTERN.exec(filename);
    if (match) return match[1];
  }
  return null;
}

/**
 * `true` si `referencia` CONTIENE la secuencia de dígitos de `operacion` — GR manda las
 * referencias como `"MercadoPago: <op>"`. Un `operacion` con menos de
 * `MIN_OPERACION_DIGITS` dígitos NUNCA matchea, aunque sea literalmente un substring de una
 * referencia real: matchear por pocos dígitos daría falsos positivos contra cualquier recibo
 * cuya referencia los contenga por casualidad (mismo piso que `extractComprobanteOperacion`).
 */
export function matchReceiptOperation(
  operacion: string | null,
  recibos: ReceiptFact[],
): MatchOperacionResult {
  if (operacion === null || operacion.length < MIN_OPERACION_DIGITS) {
    return { operacion, encontrado: false };
  }

  for (const recibo of recibos) {
    const matched = recibo.referencias.some((ref) => ref.includes(operacion));
    if (matched) {
      return { operacion, encontrado: true, importe: recibo.importe };
    }
  }

  return { operacion, encontrado: false };
}

/** Importe redondeado a CENTAVOS enteros — evita el error clásico de comparar floats (D9/R5). */
function toCentavos(importe: number): number {
  return Math.round(importe * 100);
}

/**
 * `true` si hay 2+ recibos VIGENTES del día con el MISMO importe (comparado en centavos, sin
 * errores de float). Caso real: Bravo Eduardo, 2× $77.997,19 con 2 minutos de diferencia (R5).
 */
export function detectDoublePayment(recibos: ReceiptFact[]): boolean {
  const seen = new Set<number>();
  for (const recibo of recibos) {
    const centavos = toCentavos(recibo.importe);
    if (seen.has(centavos)) return true;
    seen.add(centavos);
  }
  return false;
}

/**
 * `true` si `texto` matchea alguno de los `patterns` de promesa de pago (la fila
 * `promesa_pago`, reusada TAL CUAL — INT-2/D11: una sola lista configurable, sin columna
 * nueva). Regex inválida se ignora con warn, igual que `matchTriggerIntent` (RTR-4).
 */
export function detectPaymentPromise(texto: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`detectPaymentPromise: pattern de promesa inválido: ${pattern}`);
      continue;
    }
    if (regex.test(texto)) return true;
  }
  return false;
}
