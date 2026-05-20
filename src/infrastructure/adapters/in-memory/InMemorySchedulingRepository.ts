import { ScheduledTask, TaskStatus } from '@domain/entities/scheduling';
import { StageCategory } from '@domain/entities/workflow';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { StageRepository } from '@domain/ports/StageRepository';

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

function makeTask(raw: Omit<ScheduledTask, 'stageCategory' | 'status'> & { stageId: string }): ScheduledTask {
  const stageCategory = deriveStageCategory(raw.stageId);
  const status = deriveLegacyStatus(raw.stageId, stageCategory);
  return { ...raw, stageCategory, status };
}

export class InMemorySchedulingRepository implements SchedulingRepository {
  // Optional stage repo for accurate category resolution (useful in tests with non-sentinel IDs)
  private stageRepo?: StageRepository;

  constructor(stageRepo?: StageRepository) {
    this.stageRepo = stageRepo;
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
    }),
  ];

  async listTasks(): Promise<ScheduledTask[]> {
    return this.tasks.map(t => ({ ...t }));
  }

  async getTask(id: string): Promise<ScheduledTask | null> {
    return this.tasks.find(t => t.id === id) ? { ...this.tasks.find(t => t.id === id)! } : null;
  }

  async createTask(data: Omit<ScheduledTask, 'id' | 'sequenceNumber' | 'stageCategory' | 'status'>): Promise<ScheduledTask> {
    const stageCategory = deriveStageCategory(data.stageId);
    const status = deriveLegacyStatus(data.stageId, stageCategory);
    const task: ScheduledTask = {
      id: String(nextId++),
      sequenceNumber: nextSequenceNumber++,
      ...data,
      stageCategory,
      status,
    };
    this.tasks.push(task);
    return { ...task };
  }

  async updateTask(id: string, data: Partial<ScheduledTask>): Promise<ScheduledTask | null> {
    const index = this.tasks.findIndex(t => t.id === id);
    if (index === -1) return null;
    const merged = { ...this.tasks[index], ...data };
    const stageCategory = deriveStageCategory(merged.stageId);
    const status = deriveLegacyStatus(merged.stageId, stageCategory);
    this.tasks[index] = { ...merged, stageCategory, status };
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
}
