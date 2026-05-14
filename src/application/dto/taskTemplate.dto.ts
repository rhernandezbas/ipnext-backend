import { z } from 'zod';

export const TaskTemplateCategorySchema = z.enum(['installation', 'repair', 'maintenance', 'inspection', 'other']);

export const CreateTaskTemplateSchema = z.object({
  name:        z.string().min(1),
  description: z.string().nullable(),
  category:    TaskTemplateCategorySchema,
});

export const UpdateTaskTemplateSchema = CreateTaskTemplateSchema.partial();

export type CreateTaskTemplateInput = z.infer<typeof CreateTaskTemplateSchema>;
export type UpdateTaskTemplateInput = z.infer<typeof UpdateTaskTemplateSchema>;
