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

  // FK references compartidas (partner, reporter, assignee, watchers, travel time)
  partnerId:      z.string().min(1).nullable().optional(),
  reporterId:     z.string().min(1).nullable().optional(),
  assigneeId:     z.string().min(1).nullable().optional(),

  // NEW — watchers replace-set (array is authoritative when present)
  watcherIds:     z.array(z.string().min(1)).optional(),

  // NEW — travel time (minutes, non-negative integer)
  travelTimeTo:   z.number().int().nonnegative().nullable().optional(),
  travelTimeFrom: z.number().int().nonnegative().nullable().optional(),

  // isClosed is only on the base schema as optional so UpdateTaskSchema inherits it.
  // CreateTaskSchema does NOT expose it (DB default false covers create).
  isClosed: z.boolean().optional(),

  // #41 — lifecycle status. Optional on the base so UpdateTaskSchema inherits it
  // (PUT /:id accepts it; generalStatus wins over isClosed via UpdateTask normalize).
  // CreateTaskSchema ignores it (DB default 'open' covers create).
  generalStatus: z.enum(['open', 'closed', 'dismissed']).optional(),

  // #54 — task-level locality snapshot (iClass OS city). Required for network tasks;
  // optional (nullable) for customer tasks. The REQUIRED enforcement is a domain guard
  // (NetworkTaskLocalityRequiredError → 422), NOT a zod discriminated constraint,
  // so both kinds share this field permissively.
  iclassCityCode: z.string().nullable().optional(),
});

// REQ-VAL-1 (network-node-task #29): discriminated union on `kind`.
// CustomerTask: requiere customerId + contractId. Prohibe networkSiteId.
const CustomerTask = CreateTaskBaseSchema.extend({
  kind:         z.literal('customer'),
  customerId:   z.string().min(1),
  contractId:   z.string().min(1),
  // networkSiteId no permitido en modo customer
  networkSiteId: z.undefined().optional(),
  networkType:   z.undefined().optional(),
  networkSiteName: z.undefined().optional(),
});

// #66 — NetworkTask: single discriminator 'network', with networkType sub-discriminating red/fibra.
// Both sub-variants share the same kind='network' so we use a single member with a refine.
// networkSiteId is required for red, must be null for fibra — enforced in use-case guard (not DTO).
const NetworkTask = CreateTaskBaseSchema.extend({
  kind:         z.literal('network'),
  customerId:   z.null().optional(),
  contractId:   z.null().optional(),
  // RED: networkSiteId required. FIBRA: networkSiteId null/omitted.
  // The domain guard (CreateTask) enforces this distinction after parsing.
  networkSiteId: z.string().min(1).nullable().optional(),
  // networkType: defaults to 'red' in use-case when omitted.
  networkType:  z.enum(['red', 'fibra']).optional(),
  // #66 — free-text node name for fibra tasks.
  networkSiteName: z.string().nullable().optional(),
});

export const CreateTaskSchema = z
  .discriminatedUnion('kind', [CustomerTask, NetworkTask])
  .superRefine(dateRangeRefine)
  .superRefine((v, ctx) => {
    // #66 — For red network tasks (networkType='red' or omitted), networkSiteId is required.
    if (v.kind === 'network' && v.networkType !== 'fibra') {
      const siteId = (v as { networkSiteId?: string | null }).networkSiteId;
      if (!siteId || (typeof siteId === 'string' && !siteId.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['networkSiteId'],
          message: 'networkSiteId is required for red network tasks',
        });
      }
    }
  });

// UpdateTaskSchema — mantiene las FK como nullable/optional (sin kind obligatorio)
// Se define antes del export de tipo para que no confunda con el union.
const UpdateTaskBaseSchema = CreateTaskBaseSchema.extend({
  customerId:   z.string().min(1).nullable().optional(),
  contractId:   z.string().min(1).nullable().optional(),
  // #66 — networkType + networkSiteName on update
  networkType:  z.enum(['red', 'fibra']).nullable().optional(),
  networkSiteName: z.string().nullable().optional(),
  networkSiteId: z.string().min(1).nullable().optional(),
});

// UpdateTaskSchema hereda nullable/optional para todos los FK — sin kind obligatorio.
export const UpdateTaskSchema = UpdateTaskBaseSchema.partial().superRefine(dateRangeRefine);

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
  isClosed:   z.enum(['true', 'false']).transform(v => v === 'true').optional(),
  // #40 — filter by task kind. Omitted ⇒ all kinds. Orthogonal to #41's `status`.
  kind:       z.enum(['customer', 'network']).optional(),
  // #41 — filter by generalStatus. Omitted ≡ all (back-compat). 'all' = explicit no-filter.
  status:     z.enum(['open', 'closed', 'dismissed', 'all']).optional(),
});
export type TaskListFilter = z.infer<typeof ListTasksFilterSchema>;
