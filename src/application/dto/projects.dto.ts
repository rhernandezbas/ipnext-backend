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

/**
 * Schema for PUT /projects/:id — full replacement.
 * Does NOT include `allowsEquipmentRetirement`: the retirement flag is a
 * privileged mutation gated by inventory.manage and must only be set via
 * PATCH. Including it here would create a back-door that bypasses the guard.
 */
export const PutProjectSchema = CreateProjectSchema.extend({
  /**
   * Assigns or clears the IClass SO type mapping on a project (REQ-PROJ-7).
   * - string: must be a valid UUID (FK to IClassSoType).
   * - null: clears the mapping.
   * - omitted: leaves the existing mapping unchanged.
   */
  iclassSoTypeId: z.string().uuid().nullable().optional(),
}).partial();

/**
 * Schema for PATCH /projects/:id — partial update.
 * Superset of PutProjectSchema; adds the guarded retirement-flag field.
 * The route layer enforces inventory.manage when this field is present.
 */
export const UpdateProjectSchema = PutProjectSchema.extend({
  /**
   * #39 — enables/disables equipment retirement for this project.
   * Guarded by inventory.manage at the route layer.
   * Only settable via PATCH — deliberately excluded from PutProjectSchema.
   */
  allowsEquipmentRetirement: z.boolean().optional(),
  /**
   * #40 — marks/unmarks the project as a network (nodos) project.
   * Guarded by scheduling.manage at the route layer.
   * Only settable via PATCH — deliberately excluded from PutProjectSchema
   * (zod strips unknown keys → PUT silently ignores it, closing the back-door).
   */
  isNetworkProject: z.boolean().optional(),
});

export const ListProjectsQuerySchema = z.object({
  visible: z.enum(['true', 'false', 'all']).optional(),
});

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
export type PutProjectInput = z.infer<typeof PutProjectSchema>;
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;
export type ListProjectsQueryInput = z.infer<typeof ListProjectsQuerySchema>;
