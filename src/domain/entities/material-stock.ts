import { InsufficientStockError } from '@domain/errors/inventory';

/**
 * Balance de cantidad de un material de catálogo en una ubicación.
 * Una fila por (materialCatalogId, locationId). W1 opera solo DEPOSITO.
 */
export interface MaterialStock {
  id: string;
  materialCatalogId: string;
  locationId: string;
  qty: number;
}

export interface CreateMaterialStockInput {
  id: string;
  materialCatalogId: string;
  locationId: string;
  qty?: number;
}

/**
 * THE single qty rounding rule (Fix M2/Wave4). Quantities live in a
 * `Decimal(12,4)` column, so Prisma's `dec(n)=new Prisma.Decimal(n.toFixed(4))`
 * snaps every write to 4 decimals. The in-memory adapters store plain JS
 * `number`, which keeps binary-float artifacts (e.g. `0.1 + 0.2` =
 * `0.30000000000000004`) and would diverge from Prisma in the 17th digit.
 *
 * Both the in-memory adapters AND Prisma's `dec()` route qty writes through
 * THIS function so the two adapters land bit-identical balances. The
 * implementation mirrors `toFixed(4)` exactly: `Number(n.toFixed(4))`.
 */
export function roundQty(n: number): number {
  return Number(n.toFixed(4));
}

export function createMaterialStock(input: CreateMaterialStockInput): MaterialStock {
  return {
    id: input.id,
    materialCatalogId: input.materialCatalogId,
    locationId: input.locationId,
    qty: input.qty ?? 0,
  };
}

/**
 * Calcula la cantidad resultante de un decremento, garantizando que nunca
 * baje de cero. Si el resultado fuese negativo lanza InsufficientStockError
 * ANTES de cualquier escritura (qty=0 es válido).
 */
export function decrementStock(
  materialCatalogId: string,
  current: number,
  amount: number,
): number {
  const result = current - amount;
  if (result < 0) {
    throw new InsufficientStockError(materialCatalogId, current, amount);
  }
  return result;
}
