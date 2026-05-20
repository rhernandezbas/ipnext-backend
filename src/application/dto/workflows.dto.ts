import { z } from 'zod';

export const StageCategorySchema = z.enum(['nuevo', 'enProgreso', 'hecho']);

export const CreateStageSchema = z.object({
  name: z.string().min(1),
  category: StageCategorySchema,
  order: z.number().int().nonnegative(),
});

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  stages: z.array(CreateStageSchema).optional(),
});

export const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
});

export const ReorderStagesSchema = z.object({
  order: z.array(z.string().uuid()).min(1),
});

export const CreateProjectCategorySchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
});
export const UpdateProjectCategorySchema = CreateProjectCategorySchema.partial();

export const CreateProjectTypeSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
});
export const UpdateProjectTypeSchema = CreateProjectTypeSchema.partial();

export type CreateWorkflowInput = z.infer<typeof CreateWorkflowSchema>;
export type UpdateWorkflowInput = z.infer<typeof UpdateWorkflowSchema>;
export type CreateStageInput = z.infer<typeof CreateStageSchema>;
export type ReorderStagesInput = z.infer<typeof ReorderStagesSchema>;
export type CreateProjectCategoryInput = z.infer<typeof CreateProjectCategorySchema>;
export type UpdateProjectCategoryInput = z.infer<typeof UpdateProjectCategorySchema>;
export type CreateProjectTypeInput = z.infer<typeof CreateProjectTypeSchema>;
export type UpdateProjectTypeInput = z.infer<typeof UpdateProjectTypeSchema>;
