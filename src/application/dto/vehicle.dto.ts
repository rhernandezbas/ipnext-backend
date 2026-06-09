import { z } from 'zod';
import { Vehicle } from '@domain/entities/vehicle';

// ─── Zod input schemas ────────────────────────────────────────────────────────

export const CreateVehicleSchema = z.object({
  plate: z.string().min(1),
  name: z.string().nullish(),
  assignedTechnicianId: z.string().nullish(),
});

export const UpdateVehicleSchema = z.object({
  plate: z.string().min(1).optional(),
  name: z.string().nullable().optional(),
  assignedTechnicianId: z.string().nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export type CreateVehicleInput = z.infer<typeof CreateVehicleSchema>;
export type UpdateVehicleInput = z.infer<typeof UpdateVehicleSchema>;

// ─── Output DTO ───────────────────────────────────────────────────────────────

export interface VehicleDto {
  id: string;
  plate: string;
  name: string | null;
  assignedTechnicianId: string | null;
  status: 'active' | 'inactive';
  createdAt: string;
}

export function toVehicleDto(v: Vehicle): VehicleDto {
  return {
    id: v.id,
    plate: v.plate,
    name: v.name,
    assignedTechnicianId: v.assignedTechnicianId,
    status: v.status,
    createdAt: v.createdAt instanceof Date ? v.createdAt.toISOString() : String(v.createdAt),
  };
}
