import { z } from 'zod';

// IDs are non-empty strings (not strictly UUID). Existence is verified by the
// use case via FK lookups (returns REFERENCE_NOT_FOUND errors). The Prisma
// schema uses cuid/uuid depending on the model, and seed data in tests may
// use simpler IDs — UUID format validation here would be inconsistent.
export const CreateProjectSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  typeId: z.string().min(1).nullable().optional(),
  categoryId: z.string().min(1).nullable().optional(),
  workflowId: z.string().min(1).nullable().optional(),
  projectLeadId: z.string().min(1).nullable().optional(),
  visible: z.boolean().optional(),
  partnerIds: z.array(z.string().min(1)).optional(),
});

export const UpdateProjectSchema = CreateProjectSchema.extend({
  /**
   * Assigns or clears the IClass SO type mapping on a project (REQ-PROJ-7).
   * - string: must be a valid UUID (FK to IClassSoType).
   * - null: clears the mapping.
   * - omitted: leaves the existing mapping unchanged.
   */
  iclassSoTypeId: z.string().uuid().nullable().optional(),
}).partial();

export const ListProjectsQuerySchema = z.object({
  visible: z.enum(['true', 'false', 'all']).optional(),
});

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;
export type ListProjectsQueryInput = z.infer<typeof ListProjectsQuerySchema>;
