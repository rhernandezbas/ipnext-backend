import { z } from 'zod';

// ── ServiceCatalog ───────────────────────────────────────────────────────────

export const CreateServiceCatalogSchema = z.object({
  name:      z.string().min(1),
  label:     z.string().nullish(),
  active:    z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
export const UpdateServiceCatalogSchema = CreateServiceCatalogSchema.partial();

export type CreateServiceCatalogInput = z.infer<typeof CreateServiceCatalogSchema>;
export type UpdateServiceCatalogInput = z.infer<typeof UpdateServiceCatalogSchema>;

export interface ServiceCatalogDto {
  id:        string;
  name:      string;
  label:     string | null;
  active:    boolean;
  sortOrder: number;
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
}

// ── ContractService ──────────────────────────────────────────────────────────

export const AddContractServiceSchema = z.object({
  serviceCatalogId: z.string().min(1),
  notes:            z.string().nullish(),
});

export const UpdateContractServiceSchema = z.object({
  status: z.enum(['active', 'inactive']).optional(),
  notes:  z.string().nullish(),
});

export type AddContractServiceInput = z.infer<typeof AddContractServiceSchema>;
export type UpdateContractServiceInput = z.infer<typeof UpdateContractServiceSchema>;

export interface ContractServiceDto {
  id:               string;
  contractId:       string;
  serviceCatalogId: string;
  name:             string;
  label:            string | null;
  status:           string;
  notes:            string | null;
  createdAt:        string;   // ISO 8601
}

// ── Contract name ────────────────────────────────────────────────────────────

// W-3 — `name` is optional: PATCH body {} is a valid no-op (returns the contract unchanged).
// Present-but-null clears it; an absent key (undefined) leaves the column untouched.
export const UpdateContractNameSchema = z.object({
  name: z.string().nullable().optional(),
});
export type UpdateContractNameInput = z.infer<typeof UpdateContractNameSchema>;

export interface ContractNameDto {
  id:   string;
  name: string | null;
}
