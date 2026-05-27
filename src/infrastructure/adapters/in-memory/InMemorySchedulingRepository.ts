import { ScheduledTask, TaskStatus } from '@domain/entities/scheduling';
import { TaskChecklistItem } from '@domain/entities/checklist';
import { StageCategory } from '@domain/entities/workflow';
import { SchedulingRepository, CreateTaskInput, UpdateTaskInput } from '@domain/ports/SchedulingRepository';
import { StageRepository } from '@domain/ports/StageRepository';
import { ChecklistItemNotFoundError, OrderingError } from '@domain/errors/checklist';
import { TaskTemplateRepository } from '@domain/ports/TaskTemplateRepository';
import { TaskListFilter } from '@application/dto/scheduling.dto';

// Default stage IDs used in the in-memory repo for seeded tasks — valid UUID format
const DEFAULT_STAGE_ID_PENDING     = '10000000-0000-4000-a000-000000000001';
const DEFAULT_STAGE_ID_IN_PROGRESS = '10000000-0000-4000-a000-000000000002';
const DEFAULT_STAGE_ID_COMPLETED   = '10000000-0000-4000-a000-000000000003';
const DEFAULT_STAGE_ID_CANCELLED   = '10000000-0000-4000-a000-000000000004';

function deriveLegacyStatus(stageId: string, stageCategory: StageCategory): TaskStatus {
  if (stageId === DEFAULT_STAGE_ID_CANCELLED) return 'cancelled';
  if (stageCategory === 'hecho') return 'completed';
  if (stageCategory === 'enProgreso') return 'in_progress';
  return 'pending';
}

function deriveStageCategory(stageId: string): StageCategory {
  if (stageId === DEFAULT_STAGE_ID_IN_PROGRESS) return 'enProgreso';
  if (stageId === DEFAULT_STAGE_ID_COMPLETED) return 'hecho';
  if (stageId === DEFAULT_STAGE_ID_CANCELLED) return 'hecho';
  return 'nuevo';
}

// Map legacy status → default stage
const LEGACY_STATUS_TO_STAGE: Record<TaskStatus, { stageId: string; category: StageCategory }> = {
  pending:     { stageId: DEFAULT_STAGE_ID_PENDING,     category: 'nuevo' },
  in_progress: { stageId: DEFAULT_STAGE_ID_IN_PROGRESS, category: 'enProgreso' },
  completed:   { stageId: DEFAULT_STAGE_ID_COMPLETED,   category: 'hecho' },
  cancelled:   { stageId: DEFAULT_STAGE_ID_CANCELLED,   category: 'hecho' },
};

let nextId = 7;
let nextSequenceNumber = 8;
let nextChecklistItemId = 1;

function nowIso(): string {
  return new Date().toISOString();
}

function makeTask(raw: Omit<ScheduledTask, 'stageCategory' | 'status' | 'createdAt' | 'updatedAt'> & { stageId: string; createdAt?: string; updatedAt?: string }): ScheduledTask {
  const stageCategory = deriveStageCategory(raw.stageId);
  const status = deriveLegacyStatus(raw.stageId, stageCategory);
  const now = new Date().toISOString();
  return {
    ...raw,
    stageCategory,
    status,
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
  };
}

// NEW fields default for existing seeded tasks (no breaking changes to fixtures)
const NEW_FIELDS_DEFAULTS = {
  startDate: null,
  endDate: null,
  customerId: null,
  customerName: null,
  customerCity: null,
  serviceId: null,
  partnerId: null,
  reporterId: null,
  assigneeId: null,
  assigneeName: null,
  watcherIds: [] as string[],
  travelTimeTo: null,
  travelTimeFrom: null,
};

export class InMemorySchedulingRepository implements SchedulingRepository {
  // Optional stage repo for accurate category resolution (useful in tests with non-sentinel IDs)
  private stageRepo?: StageRepository;

  // Optional template repo for assignTemplateToTask
  private templateRepo?: TaskTemplateRepository;

  // Checklist storage keyed by taskId
  private checklist: Map<string, TaskChecklistItem[]> = new Map();

  constructor(stageRepo?: StageRepository, templateRepo?: TaskTemplateRepository) {
    this.stageRepo = stageRepo;
    this.templateRepo = templateRepo;
  }
  private tasks: ScheduledTask[] = [
    makeTask({
      id: '1',
      sequenceNumber: 1,
      title: 'Instalación fibra óptica - García',
      description: 'Instalación de servicio de fibra óptica residencial',
      assignedTo: 'Carlos Técnico',
      assignedToId: 'admin-1',
      clientId: 'cli-001',
      clientName: 'Juan García',
      stageId: DEFAULT_STAGE_ID_PENDING,
      priority: 'high',
      scheduledDate: '2026-05-02',
      scheduledTime: '09:00',
      estimatedHours: 3,
      address: 'Av. Corrientes 1234, CABA',
      coordinates: { lat: -34.6037, lng: -58.3816 },
      category: 'installation',
      projectId: null,
      projectName: null,
      completedAt: null,
      notes: 'Llevar ONT y cable UTP cat6',
      ...NEW_FIELDS_DEFAULTS,
    }),
    makeTask({
      id: '2',
      sequenceNumber: 2,
      title: 'Reparación de señal - López',
      description: 'Cliente reporta pérdida intermitente de señal',
      assignedTo: 'María Técnica',
      assignedToId: 'admin-2',
      clientId: 'cli-002',
      clientName: 'Roberto López',
      stageId: DEFAULT_STAGE_ID_IN_PROGRESS,
      priority: 'urgent',
      scheduledDate: '2026-04-28',
      scheduledTime: '10:30',
      estimatedHours: 2,
      address: 'San Martín 567, Villa Urquiza',
      coordinates: { lat: -34.5819, lng: -58.4857 },
      category: 'repair',
      projectId: null,
      projectName: null,
      completedAt: null,
      notes: 'Verificar empalme en caja de distribución',
      ...NEW_FIELDS_DEFAULTS,
    }),
    makeTask({
      id: '3',
      sequenceNumber: 3,
      title: 'Mantenimiento preventivo nodo norte',
      description: 'Revisión y limpieza de nodo de distribución norte',
      assignedTo: 'Carlos Técnico',
      assignedToId: 'admin-1',
      clientId: null,
      clientName: null,
      stageId: DEFAULT_STAGE_ID_PENDING,
      priority: 'normal',
      scheduledDate: '2026-05-05',
      scheduledTime: '08:00',
      estimatedHours: 4,
      address: 'Nodo Norte - Av. Maipú 890',
      coordinates: { lat: -34.5241, lng: -58.5157 },
      category: 'maintenance',
      projectId: null,
      projectName: null,
      completedAt: null,
      notes: 'Llevar kit de limpieza de conectores',
      ...NEW_FIELDS_DEFAULTS,
    }),
    makeTask({
      id: '4',
      sequenceNumber: 4,
      title: 'Inspección infraestructura poste 45',
      description: 'Verificación estado de instalación aérea en poste 45',
      assignedTo: 'Pedro Inspector',
      assignedToId: 'admin-3',
      clientId: null,
      clientName: null,
      stageId: DEFAULT_STAGE_ID_COMPLETED,
      priority: 'low',
      scheduledDate: '2026-04-25',
      scheduledTime: '14:00',
      estimatedHours: 1,
      address: 'Calle Rivadavia 2345',
      coordinates: { lat: -34.6127, lng: -58.4071 },
      category: 'inspection',
      projectId: null,
      projectName: null,
      completedAt: '2026-04-25T16:00:00Z',
      notes: 'Todo en orden, documentado',
      ...NEW_FIELDS_DEFAULTS,
    }),
    makeTask({
      id: '5',
      sequenceNumber: 5,
      title: 'Instalación cámara de seguridad - Martínez',
      description: 'Instalación de sistema de vigilancia IP',
      assignedTo: 'María Técnica',
      assignedToId: 'admin-2',
      clientId: 'cli-005',
      clientName: 'Ana Martínez',
      stageId: DEFAULT_STAGE_ID_PENDING,
      priority: 'normal',
      scheduledDate: '2026-05-03',
      scheduledTime: '11:00',
      estimatedHours: 2,
      address: 'Belgrano 789, Palermo',
      coordinates: { lat: -34.5888, lng: -58.4354 },
      category: 'installation',
      projectId: null,
      projectName: null,
      completedAt: null,
      notes: 'Cliente solicita 2 cámaras exteriores',
      ...NEW_FIELDS_DEFAULTS,
    }),
    makeTask({
      id: '6',
      sequenceNumber: 6,
      title: 'Reparación cable dañado por tormenta',
      description: 'Cable de distribución dañado por tormenta del 27/04',
      assignedTo: 'Carlos Técnico',
      assignedToId: 'admin-1',
      clientId: null,
      clientName: null,
      stageId: DEFAULT_STAGE_ID_CANCELLED,
      priority: 'high',
      scheduledDate: '2026-04-27',
      scheduledTime: '16:00',
      estimatedHours: 3,
      address: 'Zona Norte - Tramo calle Alem',
      coordinates: null,
      category: 'repair',
      projectId: null,
      projectName: null,
      completedAt: null,
      notes: 'Cancelado por condiciones climáticas adversas',
      ...NEW_FIELDS_DEFAULTS,
    }),
    makeTask({
      id: '7',
      sequenceNumber: 7,
      title: 'Tarea pendiente de agendar',
      description: 'Esperando confirmación de fecha por parte del cliente',
      assignedTo: null,
      assignedToId: null,
      clientId: null,
      clientName: 'Empresa XYZ',
      stageId: DEFAULT_STAGE_ID_PENDING,
      priority: 'low',
      scheduledDate: null,
      scheduledTime: null,
      estimatedHours: 2,
      address: null,
      coordinates: null,
      category: 'inspection',
      projectId: null,
      projectName: null,
      completedAt: null,
      notes: 'Coordinar con el cliente antes de agendar',
      ...NEW_FIELDS_DEFAULTS,
    }),
  ];

  async listTasks(filter?: TaskListFilter): Promise<ScheduledTask[]> {
    let tasks = this.tasks.map(t => ({ ...t }));
    if (!filter) return tasks;
    if (filter.projectId) tasks = tasks.filter(t => t.projectId === filter.projectId);
    if (filter.stageIds?.length) tasks = tasks.filter(t => filter.stageIds!.includes(t.stageId));
    if (filter.partnerId) tasks = tasks.filter(t => t.partnerId === filter.partnerId);
    if (filter.assigneeId) tasks = tasks.filter(t => t.assigneeId === filter.assigneeId);
    if (filter.priority) tasks = tasks.filter(t => t.priority === filter.priority);
    if (filter.q) {
      const q = filter.q.toLowerCase();
      tasks = tasks.filter(t => t.title.toLowerCase().includes(q));
    }
    if (filter.from) {
      const from = new Date(filter.from).getTime();
      tasks = tasks.filter(t => t.startDate != null && new Date(t.startDate).getTime() >= from);
    }
    if (filter.to) {
      const to = new Date(filter.to).getTime();
      tasks = tasks.filter(t => t.startDate != null && new Date(t.startDate).getTime() <= to);
    }
    return tasks;
  }

  async getTask(id: string): Promise<ScheduledTask | null> {
    return this.tasks.find(t => t.id === id) ? { ...this.tasks.find(t => t.id === id)! } : null;
  }

  async createTask(data: CreateTaskInput): Promise<ScheduledTask> {
    const stageCategory = deriveStageCategory(data.stageId ?? DEFAULT_STAGE_ID_PENDING);
    const status = deriveLegacyStatus(data.stageId ?? DEFAULT_STAGE_ID_PENDING, stageCategory);
    const task: ScheduledTask = {
      id: String(nextId++),
      sequenceNumber: nextSequenceNumber++,
      // Deprecated fields — no longer written (phase 2)
      assignedTo: null,
      assignedToId: null,
      clientId: null,
      clientName: null,
      scheduledDate: null,
      scheduledTime: null,
      // Core fields
      title: data.title,
      description: data.description ?? null,
      stageId: data.stageId ?? DEFAULT_STAGE_ID_PENDING,
      priority: data.priority,
      estimatedHours: data.estimatedHours,
      address: data.address ?? null,
      coordinates: data.coordinates ?? null,
      category: data.category,
      projectId: data.projectId ?? null,
      projectName: data.projectName ?? null,
      completedAt: data.completedAt ?? null,
      notes: data.notes ?? null,
      stageCategory,
      status,
      // New fields
      startDate: data.startDate ?? null,
      endDate: data.endDate ?? null,
      customerId: data.customerId ?? null,
      customerName: null, // In-memory: no JOIN, derived by Prisma adapter
      customerCity: null, // idem
      serviceId: data.serviceId ?? null,
      partnerId: data.partnerId ?? null,
      reporterId: data.reporterId ?? null,
      assigneeId: data.assigneeId ?? null,
      assigneeName: null, // In-memory: no JOIN
      watcherIds: data.watcherIds ? [...data.watcherIds] : [],
      travelTimeTo: data.travelTimeTo ?? null,
      travelTimeFrom: data.travelTimeFrom ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.tasks.push(task);
    return { ...task };
  }

  async updateTask(id: string, data: UpdateTaskInput): Promise<ScheduledTask | null> {
    const index = this.tasks.findIndex(t => t.id === id);
    if (index === -1) return null;

    const current = this.tasks[index];
    const stageId = data.stageId ?? current.stageId;
    const stageCategory = deriveStageCategory(stageId);
    const status = deriveLegacyStatus(stageId, stageCategory);

    // Watcher replace-set: present → authoritative; omitted → preserve
    const watcherIds = data.watcherIds !== undefined
      ? [...data.watcherIds]
      : [...current.watcherIds];

    this.tasks[index] = {
      ...current,
      // Deprecated fields — no longer written (phase 2)
      // Core fields
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description }),
      stageId,
      stageCategory,
      status,
      ...(data.priority !== undefined && { priority: data.priority }),
      ...(data.estimatedHours !== undefined && { estimatedHours: data.estimatedHours }),
      ...(data.address !== undefined && { address: data.address }),
      ...(data.coordinates !== undefined && { coordinates: data.coordinates }),
      ...(data.category !== undefined && { category: data.category }),
      ...(data.projectId !== undefined && { projectId: data.projectId }),
      ...(data.projectName !== undefined && { projectName: data.projectName }),
      ...(data.completedAt !== undefined && { completedAt: data.completedAt }),
      ...(data.notes !== undefined && { notes: data.notes }),
      // New fields
      ...(data.startDate !== undefined && { startDate: data.startDate }),
      ...(data.endDate !== undefined && { endDate: data.endDate }),
      ...(data.customerId !== undefined && { customerId: data.customerId }),
      ...(data.serviceId !== undefined && { serviceId: data.serviceId }),
      ...(data.partnerId !== undefined && { partnerId: data.partnerId }),
      ...(data.reporterId !== undefined && { reporterId: data.reporterId }),
      ...(data.assigneeId !== undefined && { assigneeId: data.assigneeId }),
      ...(data.travelTimeTo !== undefined && { travelTimeTo: data.travelTimeTo }),
      ...(data.travelTimeFrom !== undefined && { travelTimeFrom: data.travelTimeFrom }),
      watcherIds,
    };
    return { ...this.tasks[index] };
  }

  async deleteTask(id: string): Promise<boolean> {
    const index = this.tasks.findIndex(t => t.id === id);
    if (index === -1) return false;
    this.tasks.splice(index, 1);
    return true;
  }

  async moveTaskToStage(id: string, stageId: string): Promise<ScheduledTask | null> {
    const index = this.tasks.findIndex(t => t.id === id);
    if (index === -1) return null;
    // Try to get accurate stage category from stageRepo if injected
    let stageCategory = deriveStageCategory(stageId);
    if (this.stageRepo) {
      const stage = await this.stageRepo.getById(stageId);
      if (stage) stageCategory = stage.category;
    }
    const status = deriveLegacyStatus(stageId, stageCategory);
    const completedAt =
      stageCategory === 'hecho' && this.tasks[index].completedAt === null
        ? new Date().toISOString()
        : this.tasks[index].completedAt;
    this.tasks[index] = { ...this.tasks[index], stageId, stageCategory, status, completedAt };
    return { ...this.tasks[index] };
  }

  async updateTaskStatus(id: string, status: TaskStatus): Promise<ScheduledTask | null> {
    const stageData = LEGACY_STATUS_TO_STAGE[status];
    return this.moveTaskToStage(id, stageData.stageId);
  }

  // ── Checklist methods ────────────────────────────────────────────────────

  async getTaskWithChecklist(id: string): Promise<(ScheduledTask & { checklist: TaskChecklistItem[] }) | null> {
    const task = await this.getTask(id);
    if (!task) return null;
    const checklist = (this.checklist.get(id) ?? []).slice().sort((a, b) => a.order - b.order);
    return { ...task, checklist };
  }

  async addChecklistItem(taskId: string, text: string): Promise<TaskChecklistItem> {
    const existing = this.checklist.get(taskId) ?? [];
    const maxOrder = existing.length > 0 ? Math.max(...existing.map(i => i.order)) : -1;
    const now = nowIso();
    const item: TaskChecklistItem = {
      id: `ci-${nextChecklistItemId++}`,
      taskId,
      text,
      done: false,
      order: maxOrder + 1,
      fromTemplateItemId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.checklist.set(taskId, [...existing, item]);
    return { ...item };
  }

  async toggleChecklistItem(itemId: string): Promise<TaskChecklistItem> {
    for (const [taskId, items] of this.checklist) {
      const idx = items.findIndex(i => i.id === itemId);
      if (idx !== -1) {
        const now = nowIso();
        const updated = { ...items[idx], done: !items[idx].done, updatedAt: now };
        const newItems = [...items];
        newItems[idx] = updated;
        this.checklist.set(taskId, newItems);
        return { ...updated };
      }
    }
    throw new ChecklistItemNotFoundError(itemId);
  }

  async updateChecklistItem(itemId: string, text: string): Promise<TaskChecklistItem> {
    for (const [taskId, items] of this.checklist) {
      const idx = items.findIndex(i => i.id === itemId);
      if (idx !== -1) {
        const now = nowIso();
        const updated = { ...items[idx], text, updatedAt: now };
        const newItems = [...items];
        newItems[idx] = updated;
        this.checklist.set(taskId, newItems);
        return { ...updated };
      }
    }
    throw new ChecklistItemNotFoundError(itemId);
  }

  async removeChecklistItem(itemId: string): Promise<boolean> {
    for (const [taskId, items] of this.checklist) {
      const idx = items.findIndex(i => i.id === itemId);
      if (idx !== -1) {
        const newItems = items.filter(i => i.id !== itemId);
        this.checklist.set(taskId, newItems);
        return true;
      }
    }
    return false;
  }

  async reorderChecklistItems(taskId: string, orderedIds: string[]): Promise<TaskChecklistItem[]> {
    const existing = this.checklist.get(taskId) ?? [];
    const existingIds = new Set(existing.map(i => i.id));

    // Validate: all provided IDs must belong to this task
    for (const id of orderedIds) {
      if (!existingIds.has(id)) {
        throw new OrderingError(`Item ${id} does not belong to task ${taskId}`);
      }
    }

    // Validate: all existing items must be present in orderedIds
    for (const item of existing) {
      if (!orderedIds.includes(item.id)) {
        throw new OrderingError(`Item ${item.id} is missing from the ordered list`);
      }
    }

    const now = nowIso();
    const reordered = orderedIds.map((id, index) => {
      const item = existing.find(i => i.id === id)!;
      return { ...item, order: index, updatedAt: now };
    });
    this.checklist.set(taskId, reordered);
    return reordered.map(i => ({ ...i }));
  }

  async assignTemplateToTask(taskId: string, templateId: string): Promise<TaskChecklistItem[]> {
    if (!this.templateRepo) {
      // No template repo injected — cannot clone; used for isolated unit tests
      this.checklist.set(taskId, []);
      return [];
    }
    const template = await this.templateRepo.findByIdWithItems(templateId);
    if (!template) {
      // Caller should have validated before reaching here; return empty
      this.checklist.set(taskId, []);
      return [];
    }
    const now = nowIso();
    const items: TaskChecklistItem[] = template.items.map((ti, index) => ({
      id: `ci-${nextChecklistItemId++}`,
      taskId,
      text: ti.text,
      done: false,
      order: index,
      fromTemplateItemId: ti.id,
      createdAt: now,
      updatedAt: now,
    }));
    this.checklist.set(taskId, items);
    return items.map(i => ({ ...i }));
  }

  async clearChecklist(taskId: string): Promise<void> {
    this.checklist.set(taskId, []);
  }
}
