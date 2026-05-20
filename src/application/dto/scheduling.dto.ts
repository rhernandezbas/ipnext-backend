import { z } from 'zod';

/** @deprecated use MoveStageSchema; will be removed next change */
export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);
export const TaskPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const TaskCategorySchema = z.enum(['installation', 'repair', 'maintenance', 'inspection', 'other']);

export const CoordinatesSchema = z.object({ lat: z.number(), lng: z.number() }).nullable();

export const CreateTaskSchema = z.object({
  title:          z.string().min(1),
  description:    z.string().nullable().optional(),
  assignedTo:     z.string().nullable().optional(),
  assignedToId:   z.string().nullable().optional(),
  clientId:       z.string().nullable().optional(),
  clientName:     z.string().nullable().optional(),
  stageId:        z.string().uuid().optional(),
  priority:       TaskPrioritySchema,
  scheduledDate:  z.string().nullable().optional(),
  scheduledTime:  z.string().nullable().optional(),
  estimatedHours: z.number().nonnegative(),
  address:        z.string().nullable().optional(),
  coordinates:    CoordinatesSchema.optional(),
  category:       TaskCategorySchema,
  projectId:      z.string().nullable().optional(),
  projectName:    z.string().nullable().optional(),
  completedAt:    z.string().nullable().optional(),
  notes:          z.string().nullable().optional(),
});

export const UpdateTaskSchema = CreateTaskSchema.partial();

export const MoveStageSchema = z.object({ stageId: z.string().uuid() });

/** @deprecated use MoveStageSchema */
export const UpdateStatusSchema = z.object({ status: TaskStatusSchema });

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type MoveStageInput = z.infer<typeof MoveStageSchema>;
export type UpdateStatusInput = z.infer<typeof UpdateStatusSchema>;
