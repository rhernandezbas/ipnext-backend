import { TaskTemplate, TaskTemplateCategory } from '@domain/entities/taskTemplate';
import { TaskTemplateItem } from '@domain/entities/checklist';
import { TaskTemplateRepository } from '@domain/ports/TaskTemplateRepository';

let nextItemId = 1;

function nowIso(): string {
  return new Date().toISOString();
}

export class InMemoryTaskTemplateRepository implements TaskTemplateRepository {
  private templates: TaskTemplate[] = [
    {
      id: '1',
      name: 'Instalación fibra óptica',
      description: 'Instalación de servicio de fibra óptica residencial. Llevar ONT, cable UTP cat6 y herramientas básicas.',
      category: 'installation',
    },
    {
      id: '2',
      name: 'Reparación de señal',
      description: 'Cliente reporta pérdida de señal. Verificar empalme en caja de distribución y conectores.',
      category: 'repair',
    },
    {
      id: '3',
      name: 'Mantenimiento preventivo',
      description: 'Revisión y limpieza de nodo de distribución. Llevar kit de limpieza de conectores.',
      category: 'maintenance',
    },
    {
      id: '4',
      name: 'Inspección de infraestructura',
      description: 'Verificación del estado de la instalación aérea o subterránea. Documentar con fotos.',
      category: 'inspection',
    },
  ];

  // Items keyed by templateId
  private items: Map<string, TaskTemplateItem[]> = new Map();

  async findAll(): Promise<TaskTemplate[]> {
    return [...this.templates];
  }

  async findById(id: string): Promise<TaskTemplate | null> {
    return this.templates.find(t => t.id === id) ?? null;
  }

  async create(data: Omit<TaskTemplate, 'id'>): Promise<TaskTemplate> {
    const created: TaskTemplate = { id: String(this.templates.length + 1), ...data };
    this.templates.push(created);
    return created;
  }

  async update(id: string, data: Partial<Omit<TaskTemplate, 'id'>>): Promise<TaskTemplate | null> {
    const idx = this.templates.findIndex(t => t.id === id);
    if (idx === -1) return null;
    const current = this.templates[idx] as TaskTemplate;
    const next: TaskTemplate = {
      id: current.id,
      name: data.name ?? current.name,
      description: data.description !== undefined ? data.description : current.description,
      category: (data.category ?? current.category) as TaskTemplateCategory,
    };
    this.templates[idx] = next;
    return next;
  }

  async delete(id: string): Promise<boolean> {
    const idx = this.templates.findIndex(t => t.id === id);
    if (idx === -1) return false;
    this.templates.splice(idx, 1);
    this.items.delete(id);
    return true;
  }

  async replaceItems(templateId: string, items: { text: string }[]): Promise<TaskTemplateItem[]> {
    const now = nowIso();
    const created: TaskTemplateItem[] = items.map((item, index) => ({
      id: `item-${nextItemId++}`,
      templateId,
      text: item.text,
      order: index,
      createdAt: now,
      updatedAt: now,
    }));
    this.items.set(templateId, created);
    return [...created];
  }

  async findByIdWithItems(id: string): Promise<(TaskTemplate & { items: TaskTemplateItem[] }) | null> {
    const template = this.templates.find(t => t.id === id);
    if (!template) return null;
    const items = (this.items.get(id) ?? []).slice().sort((a, b) => a.order - b.order);
    return { ...template, items };
  }
}
