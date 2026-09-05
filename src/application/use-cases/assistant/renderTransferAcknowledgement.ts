/**
 * ai-assistant-cobranzas (fix wave W10 / R1 / D10, corregido en N1) — acuse DETERMINÍSTICO del
 * comprobante que TODAVÍA NO figura imputado.
 *
 * **Decisión del dueño (2026-09-05).** Esta rama NO puede ser un handoff mudo: el cliente mandó
 * un comprobante y merece un acuse. La derivación no cambia (label `administracion` + unassign
 * + nota privada); lo que se agrega es la respuesta.
 *
 * ⚠️ **N1 — el acuse NO afirma el MEDIO de pago, y el saldo va CALIFICADO.** La versión previa
 * decía "transferencia … como fue por transferencia (no por link)". Pero acá se llega por
 * `selectComprobanteOutcome` fila 1 —"sin match en los recibos de HOY"— y ese "sin match" es el
 * caso NORMAL: cubre el pago por link de MercadoPago que GR todavía no ingestó, y (desde D12.7)
 * TODO pago de ayer. Afirmar el medio era decirle "vos transferiste" a alguien que pagó por
 * link, exactamente la distinción que la regla 4 del dueño pide respetar.
 *
 * Y el saldo: en este punto la deuda TODAVÍA INCLUYE el pago que el cliente acaba de mostrar.
 * Decir "queda un saldo pendiente de $X" a secas es un número correcto presentado como final
 * cuando es pre-imputación. Por eso: "tu saldo a hoy, **sin contar este pago**, es $X".
 *
 * Escrito por CÓDIGO, nunca por el modelo (mismo criterio que `renderInvoiceBlock` y
 * `renderBalanceSignMessage`, D3): la frase promete una imputación manual y menciona plata.
 */

export interface RenderTransferAcknowledgementInput {
  /** Número de operación del adjunto (`comprobante_<op>.*`). `null` = no se pudo extraer. */
  operacion: string | null;
  /**
   * `cliente.saldo.debt` de la MISMA corrida, SIN el pago del comprobante imputado.
   * `null` = no disponible ⇒ no se afirma nada sobre el saldo (DFT-2).
   */
  debt: number | null;
}

function formatMoney(n: number): string {
  return Math.abs(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function renderTransferAcknowledgement(input: RenderTransferAcknowledgementInput): string {
  const partes: string[] = [];

  // Ni "transferencia" ni "MercadoPago": el medio no se sabe y no se adivina.
  partes.push(input.operacion ? `Recibimos tu comprobante, operación ${input.operacion}.` : 'Recibimos tu comprobante.');
  partes.push(
    'Todavía no lo vemos impactado en el sistema: administración lo revisa e imputa a mano y en cuanto quede aplicado te confirmamos por acá.',
  );

  if (input.debt !== null && Number.isFinite(input.debt)) {
    if (input.debt > 0) {
      partes.push(`Tu saldo a hoy, sin contar este pago, es $${formatMoney(input.debt)}.`);
    } else if (input.debt === 0) {
      partes.push('Tu cuenta a hoy, sin contar este pago, ya figura al día.');
    } else {
      partes.push(
        `Tu cuenta a hoy, sin contar este pago, ya figura al día, con un saldo a favor de $${formatMoney(input.debt)}.`,
      );
    }
  }

  partes.push('¡Gracias! — IPNEXT Cobranzas');

  return partes.join(' ');
}
