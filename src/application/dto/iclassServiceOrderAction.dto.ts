import { z } from 'zod';

/**
 * Zod schema for POST /api/scheduling/:id/iclass/close body.
 * resultCode: catalog result-code name (e.g. "RESOLVIDO")
 * commentary: mandatory comment for the IClass OS close event
 * closeDate?: ISO 8601 datetime string. Defaults to now() in the use case.
 */
export const CloseActionSchema = z.object({
  resultCode: z.string().min(1),
  commentary: z.string().min(1),
  closeDate: z.string().datetime().optional(),
});

export type CloseActionInput = z.infer<typeof CloseActionSchema>;

/**
 * Zod schema for POST /api/scheduling/:id/iclass/assign-team body.
 * teamLogin: the IClass team login from the IClassTeam catalog.
 */
export const AssignTeamSchema = z.object({
  teamLogin: z.string().min(1),
});

export type AssignTeamInput = z.infer<typeof AssignTeamSchema>;
