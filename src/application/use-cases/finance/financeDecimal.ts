import { FinanceValidationError } from '@domain/errors/finance';

/**
 * finance-growth Fase 2 fix-wave-1 (finding A, converged from BOTH reviewers)
 * — schema-derived precision/scale guards for the settables' `Update*` use
 * cases. Before this file existed, validation was only `Number.isFinite` +
 * business range (e.g. `>= 0`, `<= 100`), while the Postgres columns behind
 * them are `Decimal(precision, scale)` / 32-bit `Int`. A value the COLUMN
 * itself cannot hold — an operator pasting the INDEC index (`42000`) into
 * `monthlyRatePct Decimal(6,3)`, or a stray `1e12` into a `Decimal(12,2)` cost
 * — reached `repo.upsert` and Postgres raised a raw `PrismaClientKnownRequestError`
 * ("numeric field overflow" / "integer out of range"). That error is NOT a
 * `DomainError`, so `errorHandler` fell through its `DomainError` branch to
 * the generic 500 handler — an opaque `INTERNAL_ERROR` for what is, from the
 * caller's point of view, a plain 400 payload mistake.
 *
 * `roundToScale` closes the SILENT companion bug: Postgres rounds a
 * `Decimal(p,s)` write to `s` decimals server-side (via decimal.js under
 * Prisma, operating on the value's exact decimal string, e.g. "5.555" → the
 * column stores "5.56"), but the in-memory test double stores the raw JS
 * number untouched — so the SAME input produced `5.56` in prod and `5.555`
 * in every use-case test, an observable divergence between the double and
 * the real adapter that no test could ever catch. Rounding explicitly HERE,
 * before either repo ever sees the value, makes both agree.
 */

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/**
 * Rejects `value` if its magnitude exceeds what `Decimal(precision, scale)`
 * can represent. `maxAbs = 10^(precision - scale) - 10^(-scale)` is the exact
 * largest magnitude the column allows (e.g. `Decimal(12,2)` → `9999999999.99`,
 * `Decimal(6,3)` → `999.999`).
 */
export function assertDecimalBounds(value: number, field: string, precision: number, scale: number): void {
  const maxAbs = Math.pow(10, precision - scale) - Math.pow(10, -scale);
  if (Math.abs(value) > maxAbs) {
    throw new FinanceValidationError(
      `${field} excede la magnitud máxima permitida por la columna Decimal(${precision},${scale}) (máx ${maxAbs.toFixed(scale)})`,
    );
  }
}

/** Rejects `value` if it falls outside Postgres's 32-bit `Int` range. */
export function assertInt32Range(value: number, field: string): void {
  if (value < INT32_MIN || value > INT32_MAX) {
    throw new FinanceValidationError(`${field} excede el rango de un entero de 32 bits (INT) permitido por la columna`);
  }
}

/**
 * Rounds `value` to `scale` decimals BEFORE persisting, so the in-memory double
 * and the real Prisma/Postgres round-trip agree on the observable result for the
 * SAME input. That is the property this function guarantees, and the only one.
 *
 * ⚠️ It is NOT Postgres's rounding, and must not be described as such
 * (re-review of fix-wave-1, measured counterexamples at scale 2):
 *
 *     input     roundToScale   Postgres numeric(p,2)
 *     1.005  →  1.00           1.01
 *     1.015  →  1.01           1.02
 *     10.075 →  10.07          10.08
 *
 * Cause: `Math.round` sees the BINARY value, not the decimal literal —
 * `1.005 * 100 === 100.49999999999999`, so it rounds down where Postgres's
 * decimal half-up rounds up. (The `5.555` used in the original test happens to
 * be one of the values where both agree — it proved nothing.) Negatives differ
 * too: `Math.round` breaks ties toward +∞, Postgres away from zero.
 *
 * Why this is still SAFE here: the already-rounded value is what gets written,
 * so Postgres has nothing left to round and both sides observe the same number.
 * The only consequence is that a hostile half like `1.005` is stored as `1.00`
 * instead of `1.01` — a sub-cent difference on a config value, accepted.
 *
 * 🚨 DO NOT remove this rounding on the assumption that "Postgres does the same
 * thing" — it does not, and dropping it reintroduces the in-memory↔Prisma
 * divergence this function exists to close, inverted. If exact decimal
 * semantics are ever required, round over the decimal STRING representation
 * (`Number(value.toFixed(scale))`) or use a real decimal library.
 */
export function roundToScale(value: number, scale: number): number {
  const factor = Math.pow(10, scale);
  return Math.round(value * factor) / factor;
}
