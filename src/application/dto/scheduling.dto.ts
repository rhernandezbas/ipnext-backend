import { z } from 'zod';

export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);
export const TaskPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const TaskCategorySchema = z.enum(['installation', 'repair', 'maintenance', 'inspection', 'other']);

export const CoordinatesSchema = z.object({ lat: z.number(), lng: z.number() }).nullable();

export const CreateTaskSchema = z.object({
  title:          z.string().min(1),
  description:    z.string().nullable(),
  assignedTo:     z.string().nullable(),
  assignedToId:   z.string().nullable(),
  clientId:       z.string().nullable(),
  clientName:     z.string().nullable(),
  status:         TaskStatusSchema,
  priority:       TaskPrioritySchema,
  scheduledDate:  z.string().nullable(),
  scheduledTime:  z.string().nullable(),
  estimatedHours: z.number().nonnegative(),
  address:        z.string().nullable(),
  coordinates:    CoordinatesSchema,
  category:       TaskCategorySchema,
  projectId:      z.string().nullable().optional(),
  projectName:    z.string().nullable().optional(),
  completedAt:    z.string().nullable(),
  notes:          z.string().nullable(),
});

export const UpdateTaskSchema = CreateTaskSchema.partial();

export const UpdateStatusSchema = z.object({ status: TaskStatusSchema });

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type UpdateStatusInput = z.infer<typeof UpdateStatusSchema>;
