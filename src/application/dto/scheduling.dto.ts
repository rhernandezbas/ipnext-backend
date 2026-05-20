import { z } from 'zod';

/** @deprecated use MoveStageSchema; will be removed next change */
export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);
export const TaskPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const TaskCategorySchema = z.enum(['installation', 'repair', 'maintenance', 'inspection', 'other']);

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

  // DEPRECATED — still accepted for one release
  assignedTo:     z.string().nullable().optional(),
  assignedToId:   z.string().nullable().optional(),
  clientId:       z.string().nullable().optional(),
  clientName:     z.string().nullable().optional(),
  scheduledDate:  z.string().nullable().optional(),
  scheduledTime:  z.string().nullable().optional(),

  stageId:        z.string().min(1).optional(),
  priority:       TaskPrioritySchema,
  estimatedHours: z.number().nonnegative(),
  address:        z.string().nullable().optional(),
  coordinates:    CoordinatesSchema.optional(),
  category:       TaskCategorySchema,
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

/** @deprecated use MoveStageSchema */
export const UpdateStatusSchema = z.object({ status: TaskStatusSchema });

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type MoveStageInput = z.infer<typeof MoveStageSchema>;
export type UpdateStatusInput = z.infer<typeof UpdateStatusSchema>;

// ── Filter DTO ───────────────────────────────────────────────────────────────
// Wire format decision (REQ-URL-SYNC-4 & tasks.md 1.6):
// Frontend sends ?stageIds[]=a&stageIds[]=b; Express parses as req.query['stageIds[]'].
// The route normalises the raw query before passing here so this schema uses
// the JS-friendly key `stageIds`.
export const ListTasksFilterSchema = z.object({
  projectId:  z.string().min(1).optional(),
  stageIds:   z.array(z.string().min(1)).optional(),
  partnerId:  z.string().min(1).optional(),
  assigneeId: z.string().min(1).optional(),
  q:          z.string().optional(),
});
export type TaskListFilter = z.infer<typeof ListTasksFilterSchema>;
