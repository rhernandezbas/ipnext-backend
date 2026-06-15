/**
 * DTOs for the Technician↔Team mapping endpoints (Ola A).
 * Whitelist only — no Prisma/entity leakage.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Input schema (PATCH body)
// ---------------------------------------------------------------------------

export const patchTechnicianTeamMappingSchema = z.object({
  iclassTeamLogin: z.string().min(1).nullable(),
});

export type PatchTechnicianTeamMappingBody = z.infer<typeof patchTechnicianTeamMappingSchema>;

// ---------------------------------------------------------------------------
// Output DTO (GET list item + PATCH response)
// ---------------------------------------------------------------------------

export interface TechnicianTeamMappingItemDTO {
  userId: string;
  userName: string;
  userLogin: string;
  iclassTeamLogin: string | null;
  teamName: string | null;
  teamActive: boolean;
}

export interface TechnicianTeamMappingListDTO {
  items: TechnicianTeamMappingItemDTO[];
}

/** Maps the use case output to the wire DTO. */
export function toTechnicianTeamMappingItemDTO(row: {
  userId: string;
  userName: string;
  userLogin: string;
  iclassTeamLogin: string | null;
  teamName: string | null;
  teamActive: boolean;
}): TechnicianTeamMappingItemDTO {
  return {
    userId: row.userId,
    userName: row.userName,
    userLogin: row.userLogin,
    iclassTeamLogin: row.iclassTeamLogin,
    teamName: row.teamName,
    teamActive: row.teamActive,
  };
}
