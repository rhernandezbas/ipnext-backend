import { ScheduledTask, TaskStatus } from '@domain/entities/scheduling';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';

let nextId = 7;

export class InMemorySchedulingRepository implements SchedulingRepository {
  private tasks: ScheduledTask[] = [
    {
      id: '1',
      title: 'Instalación fibra óptica - García',
      description: 'Instalación de servicio de fibra óptica residencial',
      assignedTo: 'Carlos Técnico',
      assignedToId: 'admin-1',
      clientId: 'cli-001',
      clientName: 'Juan García',
      status: 'pending',
      priority: 'high',
      scheduledDate: '2026-05-02',
      scheduledTime: '09:00',
      estimatedHours: 3,
      address: 'Av. Corrientes 1234, CABA',
      coordinates: { lat: -34.6037, lng: -58.3816 },
      category: 'installation',
      completedAt: null,
      notes: 'Llevar ONT y cable UTP cat6',
    },
    {
      id: '2',
      title: 'Reparación de señal - López',
      description: 'Cliente reporta pérdida intermitente de señal',
      assignedTo: 'María Técnica',
      assignedToId: 'admin-2',
      clientId: 'cli-002',
      clientName: 'Roberto López',
      status: 'in_progress',
      priority: 'urgent',
      scheduledDate: '2026-04-28',
      scheduledTime: '10:30',
      estimatedHours: 2,
      address: 'San Martín 567, Villa Urquiza',
      coordinates: { lat: -34.5819, lng: -58.4857 },
      category: 'repair',
      completedAt: null,
      notes: 'Verificar empalme en caja de distribución',
    },
    {
      id: '3',
      title: 'Mantenimiento preventivo nodo norte',
      description: 'Revisión y limpieza de nodo de distribución norte',
      assignedTo: 'Carlos Técnico',
      assignedToId: 'admin-1',
      clientId: null,
      clientName: null,
      status: 'pending',
      priority: 'normal',
      scheduledDate: '2026-05-05',
      scheduledTime: '08:00',
      estimatedHours: 4,
      address: 'Nodo Norte - Av. Maipú 890',
      coordinates: { lat: -34.5241, lng: -58.5157 },
      category: 'maintenance',
      completedAt: null,
      notes: 'Llevar kit de limpieza de conectores',
    },
    {
      id: '4',
      title: 'Inspección infraestructura poste 45',
      description: 'Verificación estado de instalación aérea en poste 45',
      assignedTo: 'Pedro Inspector',
      assignedToId: 'admin-3',
      clientId: null,
      clientName: null,
      status: 'completed',
      priority: 'low',
      scheduledDate: '2026-04-25',
      scheduledTime: '14:00',
      estimatedHours: 1,
      address: 'Calle Rivadavia 2345',
      coordinates: { lat: -34.6127, lng: -58.4071 },
      category: 'inspection',
      completedAt: '2026-04-25T16:00:00Z',
      notes: 'Todo en orden, documentado',
    },
    {
      id: '5',
      title: 'Instalación cámara de seguridad - Martínez',
      description: 'Instalación de sistema de vigilancia IP',
      assignedTo: 'María Técnica',
      assignedToId: 'admin-2',
      clientId: 'cli-005',
      clientName: 'Ana Martínez',
      status: 'pending',
      priority: 'normal',
      scheduledDate: '2026-05-03',
      scheduledTime: '11:00',
      estimatedHours: 2,
      address: 'Belgrano 789, Palermo',
      coordinates: { lat: -34.5888, lng: -58.4354 },
      category: 'installation',
      completedAt: null,
      notes: 'Cliente solicita 2 cámaras exteriores',
    },
    {
      id: '6',
      title: 'Reparación cable dañado por tormenta',
      description: 'Cable de distribución dañado por tormenta del 27/04',
      assignedTo: 'Carlos Técnico',
      assignedToId: 'admin-1',
      clientId: null,
      clientName: null,
      status: 'cancelled',
      priority: 'high',
      scheduledDate: '2026-04-27',
      scheduledTime: '16:00',
      estimatedHours: 3,
      address: 'Zona Norte - Tramo calle Alem',
      coordinates: null,
      category: 'repair',
      completedAt: null,
      notes: 'Cancelado por condiciones climáticas adversas',
    },
  ];

  async listTasks(): Promise<ScheduledTask[]> {
    return [...this.tasks];
  }

  async getTask(id: string): Promise<ScheduledTask | null> {
    return this.tasks.find(t => t.id === id) ?? null;
  }

  async createTask(data: Omit<ScheduledTask, 'id'>): Promise<ScheduledTask> {
    const task: ScheduledTask = {
      id: String(nextId++),
      ...data,
    };
    this.tasks.push(task);
    return { ...task };
  }

  async updateTask(id: string, data: Partial<ScheduledTask>): Promise<ScheduledTask | null> {
    const index = this.tasks.findIndex(t => t.id === id);
    if (index === -1) return null;
    this.tasks[index] = { ...this.tasks[index], ...data };
    return { ...this.tasks[index] };
  }

  async deleteTask(id: string): Promise<boolean> {
    const index = this.tasks.findIndex(t => t.id === id);
    if (index === -1) return false;
    this.tasks.splice(index, 1);
    return true;
  }

  async updateTaskStatus(id: string, status: TaskStatus): Promise<ScheduledTask | null> {
    const index = this.tasks.findIndex(t => t.id === id);
    if (index === -1) return null;
    this.tasks[index] = {
      ...this.tasks[index],
      status,
      completedAt: status === 'completed' ? new Date().toISOString() : this.tasks[index].completedAt,
    };
    return { ...this.tasks[index] };
  }
}
