import type { MessagingRatesConfig } from '@domain/ports/MessagingRatesConfigRepository';
import { MESSAGING_RATES_CONFIG_DEFAULTS } from '@domain/ports/MessagingRatesConfigRepository';
import type { CreditBalance } from '@domain/ports/CreditBalancePort';
import { addMoney, compareMoney, formatMoney, multiplyMoneyByCount, tryParseMoney } from '@domain/services/fixedPointMoney';

/**
 * twilio-credit-guard (D4.a, COST-1..4) — módulo PURO, molde
 * `externalBulkPayloadHash.ts`: sin I/O, sin dependencias de infra, nunca tira.
 * `ValidateExternalBulk`/`SendExternalBulk` lo consumen tal cual (advisory vs
 * gate, respectivamente — la diferencia de comportamiento vive en el use case,
 * no acá).
 */
export type MessagingTemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

export interface MessagingCreditDto {
  /** Saldo del proveedor, 4 decimales. `null` cuando `unknown`. */
  available: string | null;
  currency: string;
  /** La categoría USADA para tarifar (nunca undefined — ver categoryAssumed). */
  category: MessagingTemplateCategory;
  /** Presente y `true` SOLO si la categoría del template faltaba/era desconocida ⇒ se tarifó MARKETING. */
  categoryAssumed?: true;
  /**
   * tarifa de la categoría + providerFee, 4 decimales.
   * fix wave F1 (F8) — `null` cuando la TARIFA no se pudo resolver (fila
   * ilegible, repo caído, overflow). Antes decía '0.0000': un cero es un
   * número, y quien lo lee razona "gratis" — la verdad es "no sé".
   */
  unitCost: string | null;
  /** unitCost × validCount, 4 decimales. `null` en los mismos casos que `unitCost` (F8). */
  estimatedCost: string | null;
  /** `false` si `estimatedCost > available`. `false` también cuando `unknown` (fail-safe). */
  sufficient: boolean;
  /** Presente y `true` cuando el balance no se pudo leer o la moneda no coincide. */
  unknown?: true;
}

export interface EstimateMessagingCostArgs {
  /** `template.category` de `listTemplates` — puede venir undefined (template pending). */
  category: string | undefined;
  validCount: number;
  /**
   * fix wave F1 (F4) — `null` ⇒ la config de tarifas NO se pudo leer (el repo
   * reventó). Degrada a `unknown`; NUNCA se adivinan los defaults para decidir
   * si se gasta plata real (D4.c).
   */
  rates: MessagingRatesConfig | null;
  /** `null` ⇒ el balance no se pudo leer ⇒ `unknown:true`, `sufficient:false`. */
  balance: CreditBalance | null;
}

const KNOWN_CATEGORIES: readonly MessagingTemplateCategory[] = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];

/**
 * COST-2 — trim + upper; si no matchea una de las 3 categorías conocidas ⇒
 * MARKETING (fail-safe: la más cara — sobre-estima y bloquea de más, nunca
 * sub-estima).
 */
function normalizeCategory(input: string | undefined): {
  category: MessagingTemplateCategory;
  categoryAssumed: boolean;
} {
  const candidate = (input ?? '').trim().toUpperCase();
  const match = KNOWN_CATEGORIES.find((c) => c === candidate);
  if (match) {
    return { category: match, categoryAssumed: false };
  }
  return { category: 'MARKETING', categoryAssumed: true };
}

function rateFor(category: MessagingTemplateCategory, rates: MessagingRatesConfig): string {
  switch (category) {
    case 'UTILITY':
      return rates.utilityRate;
    case 'AUTHENTICATION':
      return rates.authenticationRate;
    case 'MARKETING':
    default:
      return rates.marketingRate;
  }
}

/** COST-1..4 — puro, total, nunca tira. Ver design.md D4.a para el paso a paso. */
export function estimateMessagingCost(args: EstimateMessagingCostArgs): MessagingCreditDto {
  const { category, categoryAssumed } = normalizeCategory(args.category);
  // fix wave F1 (F4) — sin `rates` no hay moneda REAL que reportar; se usa la
  // de los defaults SOLO como etiqueta del DTO (el bloque entero va `unknown`,
  // así que nadie compara contra ella).
  const currency = args.rates?.currency ?? MESSAGING_RATES_CONFIG_DEFAULTS.currency;

  // COST-1/COST-2 — unitCost. Una tarifa/fee ilegible en la fila (SQL a mano)
  // NUNCA se trata como 0 (memoria "basura-al-valor-SEGURO-no-al-default"):
  // degrada a `unknown`, que ya fuerza `sufficient:false` más abajo.
  const rateMicro = args.rates === null ? null : tryParseMoney(rateFor(category, args.rates));
  const feeMicro = args.rates === null ? null : tryParseMoney(args.rates.providerFee);
  const rateIllegible = rateMicro === null || feeMicro === null;
  const unitCostMicro = rateIllegible ? null : addMoney(rateMicro, feeMicro);

  // COST-3 — estimatedCost, enteramente en enteros de 1/10000.
  // fix wave F1 (F6) — `multiplyMoneyByCount` TIRA `MoneyParseError` en
  // overflow de safe-integer (tarifa monstruosa escrita por SQL a mano). Este
  // módulo se documenta como "nunca tira" y sus DOS consumidores (advisory y
  // gate) dependen de eso: el overflow degrada a `unknown` acá mismo, jamás
  // sube como un 500.
  let estimatedCostMicro: number | null = null;
  let overflowed = false;
  if (unitCostMicro !== null) {
    try {
      estimatedCostMicro = multiplyMoneyByCount(unitCostMicro, args.validCount);
    } catch {
      overflowed = true;
      estimatedCostMicro = null;
    }
  }

  // COST-4 — suficiencia + mismatch de moneda. `unknown` acumula CUALQUIER
  // motivo de degradación (tarifa ilegible, sin balance, moneda distinta,
  // balance ilegible) — todos cierran el guard de la misma forma.
  let unknown = rateIllegible || overflowed;
  let availableMicro: number | null = null;

  if (!unknown) {
    if (args.balance === null) {
      unknown = true;
    } else if (args.balance.currency !== currency) {
      // La conversión de moneda NO existe (out of scope, D3.c) — NUNCA se
      // compara a ciegas entre monedas distintas.
      unknown = true;
    } else {
      const parsedAvailable = tryParseMoney(args.balance.amount);
      if (parsedAvailable === null) {
        unknown = true;
      } else {
        availableMicro = parsedAvailable;
      }
    }
  }

  const sufficient =
    !unknown &&
    availableMicro !== null &&
    estimatedCostMicro !== null &&
    compareMoney(estimatedCostMicro, availableMicro) <= 0;

  return {
    available: unknown || availableMicro === null ? null : formatMoney(availableMicro),
    currency,
    category,
    ...(categoryAssumed ? { categoryAssumed: true as const } : {}),
    // fix wave F1 (F8) — `null`, no '0.0000', cuando la TARIFA no se resolvió.
    // Ojo: `balance:null`/moneda distinta también dan `unknown`, pero ahí el
    // costo SÍ se conoce y se sigue reportando (es información útil).
    unitCost: unitCostMicro === null ? null : formatMoney(unitCostMicro),
    estimatedCost: estimatedCostMicro === null ? null : formatMoney(estimatedCostMicro),
    sufficient,
    ...(unknown ? { unknown: true as const } : {}),
  };
}
