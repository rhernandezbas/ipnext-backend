import { z } from 'zod';

function fmt(kbps: number): string {
  return kbps >= 1000 ? `${kbps / 1000}M` : `${kbps}k`;
}

export interface PlanDto {
  id: string;
  code: string;
  name: string;
  category: string;
  downloadKbps: number;
  uploadKbps: number;
  status: string;
  rateLimit: string;
  createdAt: string;
  updatedAt: string;
}

export function toPlanDto(p: {
  id: string;
  code: string;
  name: string;
  category: string;
  downloadKbps: number;
  uploadKbps: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}): PlanDto {
  return { ...p, rateLimit: `${fmt(p.uploadKbps)}/${fmt(p.downloadKbps)}` };
}

export const CreatePlanBodySchema = z.object({
  code:         z.string().min(1),
  name:         z.string().min(1),
  category:     z.enum(['Air', 'Alta', 'Corte']),
  downloadKbps: z.number().int().positive(),
  uploadKbps:   z.number().int().positive(),
  status:       z.enum(['enabled', 'disabled']).optional(),
});
export type CreatePlanBody = z.infer<typeof CreatePlanBodySchema>;

export const UpdatePlanBodySchema = z.object({
  name:         z.string().min(1).optional(),
  category:     z.enum(['Air', 'Alta', 'Corte']).optional(),
  downloadKbps: z.number().int().positive().optional(),
  uploadKbps:   z.number().int().positive().optional(),
  status:       z.enum(['enabled', 'disabled']).optional(),
}).refine(d => Object.keys(d).length > 0, { message: 'At least one field must be provided' });
export type UpdatePlanBody = z.infer<typeof UpdatePlanBodySchema>;
