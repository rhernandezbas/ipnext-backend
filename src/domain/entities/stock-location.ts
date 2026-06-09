import { InvalidLocationTypeError, MissingLocationFkError } from '@domain/errors/inventory';

export type StockLocationType = 'DEPOSITO' | 'CLIENTE' | 'TECNICO';

const VALID_TYPES: readonly StockLocationType[] = ['DEPOSITO', 'CLIENTE', 'TECNICO'];

/**
 * Ubicación física/lógica de inventario. DEPOSITO es singleton (code único);
 * CLIENTE lleva contractId; TECNICO lleva technicianId. CAMIONETA es W5.
 */
export interface StockLocation {
  id: string;
  type: StockLocationType;
  /** Clave estable del singleton DEPOSITO (ej. 'DEPOSITO'). null para CLIENTE/TECNICO. */
  code: string | null;
  contractId: string | null;
  technicianId: string | null;
}

export interface CreateStockLocationInput {
  id: string;
  type: StockLocationType;
  code?: string | null;
  contractId?: string | null;
  technicianId?: string | null;
}

/**
 * Construye una StockLocation validando el combo type + FK.
 * - CLIENTE exige contractId.
 * - TECNICO exige technicianId.
 * - DEPOSITO no lleva FKs.
 * Cualquier violación se rechaza en el dominio.
 */
export function createStockLocation(input: CreateStockLocationInput): StockLocation {
  if (!VALID_TYPES.includes(input.type)) {
    throw new InvalidLocationTypeError(String(input.type));
  }
  if (input.type === 'CLIENTE' && !input.contractId) {
    throw new MissingLocationFkError('CLIENTE', 'contractId');
  }
  if (input.type === 'TECNICO' && !input.technicianId) {
    throw new MissingLocationFkError('TECNICO', 'technicianId');
  }
  return {
    id: input.id,
    type: input.type,
    code: input.code ?? null,
    contractId: input.type === 'CLIENTE' ? input.contractId! : null,
    technicianId: input.type === 'TECNICO' ? input.technicianId! : null,
  };
}
