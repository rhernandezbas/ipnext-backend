import { z } from 'zod';

/** @deprecated priority is now a free-text value backed by the TaskPriority catalog. */
export const TaskPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);

// TaskPriority catalog DTOs (name + color + sort weight)
export const CreateTaskPrioritySchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1),
  weight: z.number().int(),
});
export const UpdateTaskPrioritySchema = CreateTaskPrioritySchema.partial();
export type CreateTaskPriorityInput = z.infer<typeof CreateTaskPrioritySchema>;
export type UpdateTaskPriorityInput = z.infer<typeof UpdateTaskPrioritySchema>;
/** @deprecated category is now a free-text value backed by the TaskCategory catalog. */
export const TaskCategorySchema = z.enum(['installation', 'repair', 'maintenance', 'inspection', 'other']);

// TaskCategory catalog DTOs (mirror ProjectCategory)
export const CreateTaskCategorySchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
});
export const UpdateTaskCategorySchema = CreateTaskCategorySchema.partial();
export type CreateTaskCategoryInput = z.infer<typeof CreateTaskCategorySchema>;
export type UpdateTaskCategoryInput = z.infer<typeof UpdateTaskCategorySchema>;

export const CoordinatesSchema = z.object({ lat: z.number(), lng: z.number() }).nullable();

const dateRangeRefine = (v: { startDate?: string | null; endDate?: string | null }, ctx: z.RefinementCtx) => {
  if (v.startDate && v.endDate) {
    if (new Date(v.endDate).getTime() < new Date(v.startDate).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'endDate must be greater than or equal to startDate',
      });
    }
  }
};

const CreateTaskBaseSchema = z.object({
  title:          z.string().min(1),
  description:    z.string().nullable().optional(),

  stageId:        z.string().min(1).optional(),
  priority:       z.string().min(1),   // free text backed by the TaskPriority catalog
  estimatedHours: z.number().nonnegative(),
  address:        z.string().nullable().optional(),
  coordinates:    CoordinatesSchema.optional(),
  category:       z.string().min(1),   // free text backed by the TaskCategory catalog
  projectId:      z.string().nullable().optional(),
  projectName:    z.string().nullable().optional(),
  completedAt:    z.string().nullable().optional(),
  notes:          z.string().nullable().optional(),

  // NEW — datetime envelope
  startDate:      z.string().datetime({ offset: true }).nullable().optional(),
  endDate:        z.string().datetime({ offset: true }).nullable().optional(),

  // NEW — FK references (min(1) NOT uuid — project uses mixed ID formats)
  customerId:     z.string().min(1).nullable().optional(),
  serviceId:      z.string().min(1).nullable().optional(),
  partnerId:      z.string().min(1).nullable().optional(),
  reporterId:     z.string().min(1).nullable().optional(),
  assigneeId:     z.string().min(1).nullable().optional(),

  // NEW — watchers replace-set (array is authoritative when present)
  watcherIds:     z.array(z.string().min(1)).optional(),

  // NEW — travel time (minutes, non-negative integer)
  travelTimeTo:   z.number().int().nonnegative().nullable().optional(),
  travelTimeFrom: z.number().int().nonnegative().nullable().optional(),
});

export const CreateTaskSchema = CreateTaskBaseSchema.superRefine(dateRangeRefine);

export const UpdateTaskSchema = CreateTaskBaseSchema.partial().superRefine(dateRangeRefine);

export const MoveStageSchema = z.object({ stageId: z.string().min(1) });

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type MoveStageInput = z.infer<typeof MoveStageSchema>;

// ── Filter DTO ───────────────────────────────────────────────────────────────
// Wire format decision (REQ-URL-SYNC-4 & tasks.md 1.6):
// Frontend sends ?stageIds[]=a&stageIds[]=b; Express parses as req.query['stageIds[]'].
// The route normalises the raw query before passing here so this schema uses
// the JS-friendly key `stageIds`.
export const ListTasksFilterSchema = z.object({
  projectId:  z.string().min(1).optional(),
  stageIds:   z.array(z.string().min(1)).optional(),
  customerId: z.string().min(1).optional(),
  partnerId:  z.string().min(1).optional(),
  assigneeId: z.string().min(1).optional(),
  priority:   z.string().min(1).optional(),   // free text backed by the TaskPriority catalog
  q:          z.string().optional(),
  from:       z.string().datetime({ offset: true }).optional(),
  to:         z.string().datetime({ offset: true }).optional(),
});
export type TaskListFilter = z.infer<typeof ListTasksFilterSchema>;
