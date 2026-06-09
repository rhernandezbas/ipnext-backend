import {
  InventoryMovementRepository,
  RecordMovementInput,
} from '@domain/ports/InventoryMovementRepository';
import { InventoryMovement } from '@domain/entities/inventory-movement';

/**
 * Ledger primitive — EL ÚNICO punto de mutación de inventario.
 *
 * Registra una fila de ledger inmutable Y actualiza el balance materializado
 * (asset.currentLocationId/status para serializados, MaterialStock.qty para
 * consumibles) de forma atómica. Las garantías viven en el repositorio
 * (`record()` valida shape XOR + qty>0 y el guard de stock negativo ANTES de
 * cualquier escritura). El caso de uso depende solo del port — nunca de
 * infraestructura (DIP estricta).
 */
export class RecordInventoryMovement {
  constructor(private readonly movements: InventoryMovementRepository) {}

  execute(input: RecordMovementInput): Promise<InventoryMovement> {
    return this.movements.record(input);
  }
}
