/**
 * Vehicle catalog entity (EPIC #38, Wave 5b).
 * Mirrors MaterialCatalog — a named entity with active/inactive status.
 * Each vehicle can carry a CAMIONETA StockLocation (find-or-create on issue).
 */
export interface Vehicle {
  id: string;
  plate: string;
  name: string | null;
  assignedTechnicianId: string | null;
  status: 'active' | 'inactive';
  createdAt: Date;
}

export interface CreateVehicleInput {
  id: string;
  plate: string;
  name?: string | null;
  assignedTechnicianId?: string | null;
  status?: 'active' | 'inactive';
}

/**
 * Factory for Vehicle. Validates that plate is non-empty.
 */
export function createVehicle(input: CreateVehicleInput): Vehicle {
  if (!input.plate || !input.plate.trim()) {
    throw new Error('Vehicle plate is required');
  }
  return {
    id: input.id,
    plate: input.plate.trim().toUpperCase(),
    name: input.name ?? null,
    assignedTechnicianId: input.assignedTechnicianId ?? null,
    status: input.status ?? 'active',
    createdAt: new Date(),
  };
}
