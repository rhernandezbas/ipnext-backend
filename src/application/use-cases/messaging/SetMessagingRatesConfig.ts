import type {
  MessagingRatesConfigRepository,
  MessagingRatesConfig,
  MessagingRatesConfigPatch,
} from '@domain/ports/MessagingRatesConfigRepository';
import { ExternalBulkValidationError } from '@domain/errors/external-bulk-messaging';
import { formatMoney, parseMoney } from '@domain/services/fixedPointMoney';

/**
 * twilio-credit-guard (task 2.3/2.4, D4.e, RATES-2) — molde EXACTA
 * `SetExternalBulkConfig`: los 5 campos llegan tipados `unknown` a propósito
 * (última barrera de tipo antes del repo; el wire manda strings, la ruta HTTP
 * — B3 — no duplica esta regla con zod).
 */
export interface SetMessagingRatesConfigInput {
  currency: unknown;
  utilityRate: unknown;
  marketingRate: unknown;
  authenticationRate: unknown;
  providerFee: unknown;
}

// >= 0, <= 4 decimales, sin signo, sin notación exponencial — el wire manda
// strings; aceptar un `number` reintroduciría el float que D2 saca de raíz.
//
// fix wave F1 (F6) — la parte entera queda CAPEADA a 6 dígitos. La columna es
// `DECIMAL(10,4)`: el máximo representable es 999999.9999, y `{1,6}` + `{1,4}`
// lo expresa EXACTAMENTE (no hace falta un segundo chequeo numérico). Sin este
// tope, '1000000' pasaba la validación y reventaba río abajo: o Prisma tiraba
// un error de rango (500 opaco) o `parseMoney` tiraba `MoneyParseError` —
// que NO extiende `DomainError` y por lo tanto NUNCA mapeaba a un 4xx.
const DECIMAL_4_RE = /^\d{1,6}(\.\d{1,4})?$/;
const MAX_RATE = '999999.9999';
const CURRENCY_RE = /^[A-Z]{3}$/;

function isDecimalRateString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_4_RE.test(value);
}

export class SetMessagingRatesConfig {
  constructor(private readonly ratesRepo: MessagingRatesConfigRepository) {}

  async execute(input: SetMessagingRatesConfigInput): Promise<MessagingRatesConfig> {
    if (
      !isDecimalRateString(input.utilityRate) ||
      !isDecimalRateString(input.marketingRate) ||
      !isDecimalRateString(input.authenticationRate) ||
      !isDecimalRateString(input.providerFee)
    ) {
      throw new ExternalBulkValidationError(
        `utilityRate, marketingRate, authenticationRate and providerFee must be non-negative decimal strings with up to 4 decimals and at most ${MAX_RATE}`,
      );
    }
    if (typeof input.currency !== 'string' || !CURRENCY_RE.test(input.currency)) {
      throw new ExternalBulkValidationError('currency must be exactly 3 uppercase letters');
    }

    // Normaliza a 4 decimales (formatMoney(parseMoney(x))) antes de
    // persistir — lo que se lee después es SIEMPRE lo que se escribió.
    const patch: MessagingRatesConfigPatch = {
      currency: input.currency,
      utilityRate: formatMoney(parseMoney(input.utilityRate)),
      marketingRate: formatMoney(parseMoney(input.marketingRate)),
      authenticationRate: formatMoney(parseMoney(input.authenticationRate)),
      providerFee: formatMoney(parseMoney(input.providerFee)),
    };
    return this.ratesRepo.set(patch);
  }
}
