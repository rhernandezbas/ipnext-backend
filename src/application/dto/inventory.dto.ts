import { z } from 'zod';

export const CreateDeviceTypeSchema = z.object({
  name:      z.string().min(1),
  label:     z.string().nullish(),
  active:    z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
export const UpdateDeviceTypeSchema = CreateDeviceTypeSchema.partial();

export type CreateDeviceTypeInput = z.infer<typeof CreateDeviceTypeSchema>;
export type UpdateDeviceTypeInput = z.infer<typeof UpdateDeviceTypeSchema>;

export interface DeviceTypeCatalogDto {
  id:        string;
  name:      string;
  label:     string | null;
  active:    boolean;
  sortOrder: number;
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
}

export const CreateMaterialSchema = z.object({
  name:      z.string().min(1),
  label:     z.string().nullish(),
  unit:      z.string().nullish(),
  active:    z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  minStock:  z.number().int().min(0).optional(),
});
export const UpdateMaterialSchema = CreateMaterialSchema.partial();
export type CreateMaterialInput = z.infer<typeof CreateMaterialSchema>;
export type UpdateMaterialInput = z.infer<typeof UpdateMaterialSchema>;

export interface MaterialCatalogDto {
  id:        string;
  name:      string;
  label:     string | null;
  unit:      string | null;
  active:    boolean;
  sortOrder: number;
  minStock:  number;
  createdAt: string;
  updatedAt: string;
}
