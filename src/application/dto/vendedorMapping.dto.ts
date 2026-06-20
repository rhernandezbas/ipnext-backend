/**
 * DTOs for the agente↔vendedor (GR) mapping endpoints (Fase 2b, cartera "Mis clientes").
 * Whitelist only — no Prisma/entity leakage. GR is slated for deprecation, so this
 * mapping lives fully isolated from the core RbacUser modal/DTO.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Input schema (PATCH body)
// ---------------------------------------------------------------------------

export const patchVendedorMappingSchema = z.object({
  grVendedorName: z.string().min(1).nullable(),
});

export type PatchVendedorMappingBody = z.infer<typeof patchVendedorMappingSchema>;

// ---------------------------------------------------------------------------
// Output DTO (GET list item + PATCH response)
// ---------------------------------------------------------------------------

export interface VendedorMappingItemDTO {
  userId: string;
  userName: string;
  userLogin: string;
  grVendedorName: string | null;
}

export interface VendedorMappingListDTO {
  items: VendedorMappingItemDTO[];
}

/** Maps the use case output to the wire DTO. */
export function toVendedorMappingItemDTO(row: {
  userId: string;
  userName: string;
  userLogin: string;
  grVendedorName: string | null;
}): VendedorMappingItemDTO {
  return {
    userId: row.userId,
    userName: row.userName,
    userLogin: row.userLogin,
    grVendedorName: row.grVendedorName,
  };
}
