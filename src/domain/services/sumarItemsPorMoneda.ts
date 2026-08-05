import { normalizeGrCurrency } from './normalizeGrCurrency';

/** Una línea de cobro de un recibo: el dinero que efectivamente entró. */
export interface ReceiptItemAmount {
  amount: number;
  /** Código de moneda tal como lo manda GR (`PES`, `DOL`, …), o null. */
  moneda: string | null;
}

/** Total de un recibo en UNA moneda. */
export interface PaymentAmountEntry {
  /** ISO 4217 normalizado, o `'DESCONOCIDA'`. */
  currency: string;
  amount: number;
}

/**
 * Suma los **items** de un recibo agrupando POR MONEDA.
 *
 * ⚠️ Se usan los ITEMS y no las `aplicaciones` a propósito (PAY-1.3): las
 * aplicaciones son deuda CANCELADA y pueden EXCEDER el cash cuando el recibo trae
 * retenciones — identidad ya medida en el módulo de finanzas sobre 4.839 recibos:
 * `SUM(aplicaciones) - SUM(items) - SUM(retenciones) = 0`. Decirle al cliente que
 * pagó más de lo que pagó es mentirle sobre su propia plata.
 *
 * ⚠️ Monedas distintas NO se suman (PAY-1.4). Es la misma regla que obligó a
 * `balances[]` por moneda en `/me`: mezclar pesos con dólares da un número sin
 * sentido económico. Y una moneda ausente cae en `'DESCONOCIDA'` en vez de
 * fusionarse con una conocida, porque fusionarla sería asumir un tipo de cambio.
 *
 * Función PURA: la regla de negocio se testea sin base de datos.
 */
export function sumarItemsPorMoneda(items: readonly ReceiptItemAmount[]): PaymentAmountEntry[] {
  const porMoneda = new Map<string, number>();

  for (const item of items) {
    const currency = normalizeGrCurrency(item.moneda) ?? 'DESCONOCIDA';
    porMoneda.set(currency, (porMoneda.get(currency) ?? 0) + item.amount);
  }

  return [...porMoneda.entries()]
    .map(([currency, amount]) => ({
      currency,
      // Redondeo a centavos: sumar floats arrastra error binario (0.1 + 0.2 =
      // 0.30000000000000004) y eso no se le muestra a nadie sobre plata.
      amount: Math.round(amount * 100) / 100,
    }))
    .sort((a, b) => b.amount - a.amount);
}
