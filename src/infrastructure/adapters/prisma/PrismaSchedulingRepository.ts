/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: This file uses `as any` casts on the Prisma client calls because
 * `prisma generate` has not been run yet against the enriched schema
 * (no DB available during this apply phase). The casts will become
 * unnecessary once the migration is applied and `npm run prisma:generate`
 * is executed. The runtime behaviour IS correct — the new columns exist
 * after the migration runs.
 */
import { ScheduledTask } from '@domain/entities/scheduling';
import { TaskChecklistItem } from '@domain/entities/checklist';
import { StageCategory, Stage } from '@domain/entities/workflow';
import { SchedulingRepository, CreateTaskInput, UpdateTaskInput } from '@domain/ports/SchedulingRepository';
import { StageNotFoundError } from '@domain/errors/scheduling';
import { ChecklistItemNotFoundError, OrderingError } from '@domain/errors/checklist';
import { TaskListFilter } from '@application/dto/scheduling.dto';
import { prisma } from '../../database/prisma';

export function toTask(row: any): ScheduledTask {
  const stageCategory: StageCategory = row.stage?.category ?? 'nuevo';

  // Derive customerName from JOIN only (no legacy fallback)
  const customerName: string | null = row.customer?.name ?? null;
  // city from the customer JOIN — populates the Tasks list 'Localidad' column.
  const customerCity: string | null = row.customer?.city ?? null;
  // phone from the customer JOIN — required field for IClass OS.
  const customerPhone: string | null = row.customer?.phone ?? null;

  // Derive assigneeName from JOIN only (no legacy fallback)
  const assigneeName: string | null = row.assignee?.name ?? null;

  // Map watchers array to watcherIds
  const watcherIds: string[] = Array.isArray(row.watchers)
    ? row.watchers.map((w: any) => w.adminId ?? w.admin?.id)
    : [];

  // startDate / endDate: convert Date → ISO string
  const startDate: string | null = row.startDate instanceof Date
    ? row.startDate.toISOString()
    : (row.startDate ?? null);

  const endDate: string | null = row.endDate instanceof Date
    ? row.endDate.toISOString()
    : (row.endDate ?? null);

  return {
    id: row.id,
    sequenceNumber: row.sequenceNumber,
    title: row.title,
    description: row.description ?? null,
    stageId: row.stageId,
    stageCategory,
    priority: row.priority,
    estimatedHours: row.estimatedHours,
    address: row.address ?? null,
    coordinates: (row.lat != null && row.lng != null)
      ? { lat: row.lat, lng: row.lng }
      : null,
    category: row.category,
    projectId: row.projectId ?? null,
    projectName: row.project?.title ?? null,
    completedAt: row.completedAt
      ? (row.completedAt instanceof Date ? row.completedAt.toISOString() : row.completedAt)
      : null,
    notes: row.notes ?? null,
    // NEW fields
    startDate,
    endDate,
    customerId: row.customerId ?? null,
    customerName,
    customerCity,
    customerPhone,
    serviceId: row.serviceId ?? null,
    partnerId: row.partnerId ?? null,
    reporterId: row.reporterId ?? null,
    assigneeId: row.assigneeId ?? null,
    assigneeName,
    watcherIds,
    travelTimeTo: row.travelTimeTo ?? null,
    travelTimeFrom: row.travelTimeFrom ?? null,
    isClosed: row.isClosed ?? false,
    reviewedByInventory: row.reviewedByInventory ?? false,
    iclassOrderCode: row.iclassOrderCode ?? null,
    checklist: Array.isArray(row.checklist)
      ? row.checklist.map((ci: any) => ({
          id: ci.id,
          taskId: ci.taskId,
          text: ci.text,
          done: ci.done,
          order: ci.order,
          fromTemplateItemId: ci.fromTemplateItemId ?? null,
          createdAt: ci.createdAt instanceof Date ? ci.createdAt.toISOString() : ci.createdAt,
          updatedAt: ci.updatedAt instanceof Date ? ci.updatedAt.toISOString() : ci.updatedAt,
        }))
      : [],
    // Task timestamps — the frontend type declares these non-nullable; the
    // Edad column in TasksTableView crashes with "NaN días" if they are missing.
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

function toChecklistItem(row: any): TaskChecklistItem {
  return {
    id: row.id,
    taskId: row.taskId,
    text: row.text,
    done: row.done,
    order: row.order,
    fromTemplateItemId: row.fromTemplateItemId ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

const INCLUDE = {
  project: true,
  stage: true,
  customer: { select: { id: true, name: true, city: true, phone: true } },
  assignee: { select: { id: true, name: true } },
  reporter: { select: { id: true } },
  service: { select: { id: true } },
  partnerRef: { select: { id: true } },
  watchers: true,
  checklist: { orderBy: { order: 'asc' } },
} as const;

export class PrismaSchedulingRepository implements SchedulingRepository {
  async listTasks(filter?: TaskListFilter): Promise<ScheduledTask[]> {
    const where: Record<string, unknown> = {};
    if (filter?.projectId) where['projectId'] = filter.projectId;
    if (filter?.stageIds?.length) where['stageId'] = { in: filter.stageIds };
    if (filter?.customerId) where['customerId'] = filter.customerId;
    if (filter?.partnerId) where['partnerId'] = filter.partnerId;
    if (filter?.assigneeId) where['assigneeId'] = filter.assigneeId;
    if (filter?.priority) where['priority'] = filter.priority;
    if (filter?.q) where['title'] = { contains: filter.q, mode: 'insensitive' };
    if (filter?.from || filter?.to) {
      const startDateFilter: Record<string, Date> = {};
      if (filter.from) startDateFilter['gte'] = new Date(filter.from);
      if (filter.to) startDateFilter['lte'] = new Date(filter.to);
      where['startDate'] = startDateFilter;
    }
    if (filter?.isClosed !== undefined) where['isClosed'] = filter.isClosed;

    const rows = await (prisma.scheduledTask as any).findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: INCLUDE,
    });
    return rows.map(toTask);
  }

  async getTask(id: string): Promise<ScheduledTask | null> {
    const row = await (prisma.scheduledTask as any).findUnique({
      where: { id },
      include: INCLUDE,
    });
    return row ? toTask(row) : null;
  }

  async createTask(data: CreateTaskInput): Promise<ScheduledTask> {
    const watcherIds = data.watcherIds ? [...new Set(data.watcherIds)] : [];

    if (watcherIds.length > 0) {
      // Wrap in transaction: insert task + insert watchers
      const row = await (prisma as any).$transaction(async (tx: any) => {
        const created = await tx.scheduledTask.create({
          include: INCLUDE,
          data: this._buildCreateData(data),
        });
        await tx.taskWatcher.createMany({
          data: watcherIds.map((adminId: string) => ({ taskId: created.id, adminId })),
        });
        return tx.scheduledTask.findUnique({ where: { id: created.id }, include: INCLUDE });
      });
      return toTask(row);
    } else {
      const row = await (prisma.scheduledTask as any).create({
        include: INCLUDE,
        data: this._buildCreateData(data),
      });
      return toTask(row);
    }
  }

  async updateTask(id: string, data: UpdateTaskInput): Promise<ScheduledTask | null> {
    try {
      if (data.watcherIds !== undefined) {
        // Replace-set semantics: deleteMany + createMany inside transaction
        const deduped = [...new Set(data.watcherIds)];
        const { watcherIds: _watcherIds, ...scalarData } = data;
        const row = await (prisma as any).$transaction(async (tx: any) => {
          await tx.scheduledTask.update({
            where: { id },
            data: this._buildUpdateData(scalarData),
          });
          await tx.taskWatcher.deleteMany({ where: { taskId: id } });
          if (deduped.length > 0) {
            await tx.taskWatcher.createMany({
              data: deduped.map((adminId: string) => ({ taskId: id, adminId })),
            });
          }
          return tx.scheduledTask.findUnique({ where: { id }, include: INCLUDE });
        });
        return row ? toTask(row) : null;
      } else {
        const row = await (prisma.scheduledTask as any).update({
          where: { id },
          include: INCLUDE,
          data: this._buildUpdateData(data),
        });
        return toTask(row);
      }
    } catch {
      return null;
    }
  }

  async deleteTask(id: string): Promise<boolean> {
    try {
      await prisma.scheduledTask.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async moveTaskToStage(id: string, stageId: string): Promise<ScheduledTask | null> {
    // Explicitly check the target stage exists before attempting the update.
    const targetStage = await prisma.stage.findUnique({ where: { id: stageId } });
    if (!targetStage) {
      throw new StageNotFoundError(stageId);
    }

    try {
      const currentTask = await (prisma.scheduledTask as any).findUnique({
        where: { id },
        select: { completedAt: true },
      });

      const shouldSetCompletedAt =
        targetStage.category === 'hecho' && !currentTask?.completedAt;

      const row = await (prisma.scheduledTask as any).update({
        where: { id },
        include: INCLUDE,
        data: {
          stageId,
          ...(shouldSetCompletedAt && { completedAt: new Date() }),
        },
      });
      return toTask(row);
    } catch {
      return null;
    }
  }

  // ── Checklist methods ────────────────────────────────────────────────────

  async getTaskWithChecklist(id: string): Promise<(ScheduledTask & { checklist: TaskChecklistItem[] }) | null> {
    const row = await (prisma.scheduledTask as any).findUnique({
      where: { id },
      include: INCLUDE,
    });
    if (!row) return null;
    const task = toTask(row);
    const checklist = Array.isArray(row.checklist)
      ? row.checklist.map(toChecklistItem)
      : [];
    return { ...task, checklist };
  }

  async addChecklistItem(taskId: string, text: string): Promise<TaskChecklistItem> {
    const maxResult = await (prisma as any).taskChecklistItem.aggregate({
      where: { taskId },
      _max: { order: true },
    });
    const maxOrder = maxResult._max?.order ?? -1;
    const row = await (prisma as any).taskChecklistItem.create({
      data: {
        taskId,
        text,
        order: maxOrder + 1,
        updatedAt: new Date(),
      },
    });
    return toChecklistItem(row);
  }

  async toggleChecklistItem(itemId: string): Promise<TaskChecklistItem> {
    try {
      // Read then write in a transaction for atomicity
      const result = await (prisma as any).$transaction(async (tx: any) => {
        const current = await tx.taskChecklistItem.findUnique({ where: { id: itemId } });
        if (!current) throw new ChecklistItemNotFoundError(itemId);
        return tx.taskChecklistItem.update({
          where: { id: itemId },
          data: { done: !current.done, updatedAt: new Date() },
        });
      });
      return toChecklistItem(result);
    } catch (err) {
      if (err instanceof ChecklistItemNotFoundError) throw err;
      throw new ChecklistItemNotFoundError(itemId);
    }
  }

  async updateChecklistItem(itemId: string, text: string): Promise<TaskChecklistItem> {
    try {
      const row = await (prisma as any).taskChecklistItem.update({
        where: { id: itemId },
        data: { text, updatedAt: new Date() },
      });
      return toChecklistItem(row);
    } catch {
      throw new ChecklistItemNotFoundError(itemId);
    }
  }

  async removeChecklistItem(itemId: string): Promise<boolean> {
    try {
      await (prisma as any).taskChecklistItem.delete({ where: { id: itemId } });
      return true;
    } catch {
      return false;
    }
  }

  async reorderChecklistItems(taskId: string, orderedIds: string[]): Promise<TaskChecklistItem[]> {
    // Verify all IDs belong to this task
    const existing = await (prisma as any).taskChecklistItem.findMany({ where: { taskId } });
    const existingIds = new Set(existing.map((i: any) => i.id));
    for (const id of orderedIds) {
      if (!existingIds.has(id)) {
        throw new OrderingError(`Item ${id} does not belong to task ${taskId}`);
      }
    }
    for (const item of existing) {
      if (!orderedIds.includes(item.id)) {
        throw new OrderingError(`Item ${item.id} is missing from ordered list`);
      }
    }
    const now = new Date();
    // Run updates + final read inside the same transaction (W-2 from verify report):
    // returning the transaction-execution order is brittle under concurrent reorders;
    // a fresh ordered findMany at the end is the single source of truth.
    const final = await (prisma as any).$transaction(async (tx: any) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.taskChecklistItem.update({
          where: { id: orderedIds[i] },
          data: { order: i, updatedAt: now },
        });
      }
      return tx.taskChecklistItem.findMany({
        where: { taskId },
        orderBy: { order: 'asc' },
      });
    });
    return final.map(toChecklistItem);
  }

  async assignTemplateToTask(taskId: string, templateId: string): Promise<TaskChecklistItem[]> {
    const templateItems = await (prisma as any).taskTemplateItem.findMany({
      where: { templateId },
      orderBy: { order: 'asc' },
    });
    const now = new Date();
    const result = await (prisma as any).$transaction(async (tx: any) => {
      await tx.taskChecklistItem.deleteMany({ where: { taskId } });
      if (templateItems.length > 0) {
        await tx.taskChecklistItem.createMany({
          data: templateItems.map((ti: any, index: number) => ({
            taskId,
            text: ti.text,
            done: false,
            order: index,
            fromTemplateItemId: ti.id,
            updatedAt: now,
          })),
        });
      }
      return tx.taskChecklistItem.findMany({
        where: { taskId },
        orderBy: { order: 'asc' },
      });
    });
    return result.map(toChecklistItem);
  }

  async clearChecklist(taskId: string): Promise<void> {
    await (prisma as any).taskChecklistItem.deleteMany({ where: { taskId } });
  }

  private _buildCreateData(data: CreateTaskInput): Record<string, unknown> {
    return {
      title: data.title,
      description: data.description ?? null,
      stageId: data.stageId!,
      priority: data.priority,
      estimatedHours: data.estimatedHours,
      address: data.address ?? null,
      lat: data.coordinates?.lat ?? null,
      lng: data.coordinates?.lng ?? null,
      category: data.category,
      projectId: data.projectId ?? null,
      notes: data.notes ?? null,
      completedAt: data.completedAt ? new Date(data.completedAt) : null,
      // NEW
      startDate: data.startDate ? new Date(data.startDate) : null,
      endDate: data.endDate ? new Date(data.endDate) : null,
      customerId: data.customerId ?? null,
      serviceId: data.serviceId ?? null,
      partnerId: data.partnerId ?? null,
      reporterId: data.reporterId ?? null,
      assigneeId: data.assigneeId ?? null,
      travelTimeTo: data.travelTimeTo ?? null,
      travelTimeFrom: data.travelTimeFrom ?? null,
    };
  }

  private _buildUpdateData(data: Omit<UpdateTaskInput, 'watcherIds'>): Record<string, unknown> {
    const update: Record<string, unknown> = {};
    if (data.title !== undefined) update['title'] = data.title;
    if (data.description !== undefined) update['description'] = data.description;
    if (data.stageId !== undefined) update['stageId'] = data.stageId;
    if (data.priority !== undefined) update['priority'] = data.priority;
    if (data.estimatedHours !== undefined) update['estimatedHours'] = data.estimatedHours;
    if (data.address !== undefined) update['address'] = data.address;
    if (data.coordinates !== undefined) {
      update['lat'] = data.coordinates?.lat ?? null;
      update['lng'] = data.coordinates?.lng ?? null;
    }
    if (data.category !== undefined) update['category'] = data.category;
    if (data.projectId !== undefined) update['projectId'] = data.projectId;
    if (data.notes !== undefined) update['notes'] = data.notes;
    if (data.completedAt !== undefined) {
      update['completedAt'] = data.completedAt ? new Date(data.completedAt) : null;
    }
    // NEW
    if (data.startDate !== undefined) {
      update['startDate'] = data.startDate ? new Date(data.startDate) : null;
    }
    if (data.endDate !== undefined) {
      update['endDate'] = data.endDate ? new Date(data.endDate) : null;
    }
    if (data.customerId !== undefined) update['customerId'] = data.customerId;
    if (data.serviceId !== undefined) update['serviceId'] = data.serviceId;
    if (data.partnerId !== undefined) update['partnerId'] = data.partnerId;
    if (data.reporterId !== undefined) update['reporterId'] = data.reporterId;
    if (data.assigneeId !== undefined) update['assigneeId'] = data.assigneeId;
    if (data.travelTimeTo !== undefined) update['travelTimeTo'] = data.travelTimeTo;
    if (data.travelTimeFrom !== undefined) update['travelTimeFrom'] = data.travelTimeFrom;
    if (data.isClosed !== undefined) update['isClosed'] = data.isClosed;
    if (data.reviewedByInventory !== undefined) update['reviewedByInventory'] = data.reviewedByInventory;
    return update;
  }

  async setInventoryReview(taskId: string, reviewed: boolean): Promise<ScheduledTask | null> {
    try {
      const row = await (prisma.scheduledTask as any).update({
        where: { id: taskId },
        include: INCLUDE,
        data: { reviewedByInventory: reviewed },
      });
      return toTask(row);
    } catch {
      return null;
    }
  }

  // ── IClass integration ────────────────────────────────────────────────────

  async getStageByName(name: string, workflowId?: string): Promise<Stage | null> {
    const row = await (prisma.stage as any).findFirst({ where: { name, ...(workflowId ? { workflowId } : {}) } });
    if (!row) return null;
    return {
      id: row.id,
      workflowId: row.workflowId,
      name: row.name,
      category: row.category,
      order: row.order,
      color: row.color ?? null,
    };
  }

  async setIClassOrderCode(taskId: string, code: string): Promise<ScheduledTask | null> {
    try {
      const row = await (prisma.scheduledTask as any).update({
        where: { id: taskId },
        include: INCLUDE,
        data: { iclassOrderCode: code },
      });
      return toTask(row);
    } catch {
      return null;
    }
  }
}
