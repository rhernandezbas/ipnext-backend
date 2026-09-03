/**
 * twilio-credit-guard (D2) — aritmética de plata en punto fijo, CERO `Number`
 * flotante en el camino de decisión (parseo, multiplicación, comparación).
 * Servicio de dominio PURO (sin infra), molde de ubicación:
 * `src/domain/services/bulkRecipientAuthorization.ts`.
 *
 * Por qué no `decimal.js` en el dominio: el repo no lo usa en ningún use case
 * (exploración), y el problema acá es de dos operaciones (multiplicar por un
 * entero, comparar) — estas ~80 líneas puras y testeables baten una
 * dependencia nueva.
 *
 * Frontera con Prisma: `Decimal` ↔ **string**, nunca `Number(row.rate)`. Ver
 * `PrismaMessagingRatesConfigRepository` (D3.c).
 */

/** Enteros de 1/10000 de unidad monetaria. SIEMPRE `Number.isSafeInteger`. */
export type Micro = number;

export const MONEY_SCALE = 10_000;
export const MONEY_DECIMALS = 4;

export class MoneyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyParseError';
  }
}

/**
 * Trimeado, rechaza notación exponencial, separadores de miles, `NaN`,
 * `Infinity`. Solo dígitos (parte entera obligatoria, fracción opcional de
 * cualquier longitud — el half-up se aplica al parsear).
 */
const MONEY_STRING_RE = /^-?\d+(\.\d+)?$/;

/**
 * '17.894' → 178940 · '0.06185' → 619 (half-up) · '-3' → -30000.
 * Throws `MoneyParseError` para input no confiable (formato inválido o monto
 * que excede `Number.isSafeInteger` en micro-unidades).
 */
export function parseMoney(input: string): Micro {
  if (typeof input !== 'string') {
    throw new MoneyParseError(`Money input must be a string, got ${typeof input}`);
  }
  const trimmed = input.trim();
  if (!MONEY_STRING_RE.test(trimmed)) {
    throw new MoneyParseError(`Invalid money string: ${JSON.stringify(input)}`);
  }

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPart = ''] = unsigned.split('.');

  // Paddea la fracción a 5 dígitos (4 de escala + 1 para el redondeo half-up),
  // todo en strings — jamás pasa por un `Number` no entero.
  const fracPadded = (fracPart + '00000').slice(0, 5);
  const fracKept = fracPadded.slice(0, MONEY_DECIMALS);
  const roundDigit = fracPadded.charCodeAt(MONEY_DECIMALS) - 48; // dígito 5º, 0-9

  let microUnsigned = Number(intPart) * MONEY_SCALE + Number(fracKept);
  if (roundDigit >= 5) microUnsigned += 1;

  const result = negative ? -microUnsigned : microUnsigned;

  if (!Number.isSafeInteger(result)) {
    throw new MoneyParseError(`Money amount out of safe integer range: ${JSON.stringify(input)}`);
  }
  return result;
}

/** Igual que `parseMoney` pero devuelve `null` en vez de tirar — para input no confiable del proveedor/config. */
export function tryParseMoney(input: unknown): Micro | null {
  if (input === null || input === undefined) return null;
  const asString = typeof input === 'string' ? input : String(input);
  try {
    return parseMoney(asString);
  } catch {
    return null;
  }
}

export function addMoney(a: Micro, b: Micro): Micro {
  return a + b;
}

/** `count` DEBE ser entero >= 0 (validCount). Throws si no. */
export function multiplyMoneyByCount(m: Micro, count: number): Micro {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`multiplyMoneyByCount: count must be a non-negative integer, got ${count}`);
  }
  const result = m * count;
  if (!Number.isSafeInteger(result)) {
    throw new MoneyParseError(`multiplyMoneyByCount result out of safe integer range`);
  }
  return result;
}

export function compareMoney(a: Micro, b: Micro): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 178940 → '17.8940' — SIEMPRE 4 decimales, para mostrar/persistir. */
export function formatMoney(m: Micro): string {
  const negative = m < 0;
  const absolute = Math.abs(m);
  const intPart = Math.floor(absolute / MONEY_SCALE);
  const fracPart = absolute % MONEY_SCALE;
  const fracStr = String(fracPart).padStart(MONEY_DECIMALS, '0');
  return `${negative ? '-' : ''}${intPart}.${fracStr}`;
}
