import { randomUUID } from 'crypto';
import { ProjectType } from '@domain/entities/projectType';
import { ProjectTypeRepository } from '@domain/ports/ProjectTypeRepository';

export class InMemoryProjectTypeRepository implements ProjectTypeRepository {
  private items: ProjectType[] = [];

  async list(): Promise<ProjectType[]> {
    return this.items.map(i => ({ ...i }));
  }

  async getById(id: string): Promise<ProjectType | null> {
    const item = this.items.find(i => i.id === id);
    return item ? { ...item } : null;
  }

  async getByName(name: string): Promise<ProjectType | null> {
    const item = this.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    return item ? { ...item } : null;
  }

  async create(data: { name: string; description: string | null }): Promise<ProjectType> {
    const item: ProjectType = { id: randomUUID(), name: data.name, description: data.description };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, data: Partial<{ name: string; description: string | null }>): Promise<ProjectType | null> {
    const index = this.items.findIndex(i => i.id === id);
    if (index === -1) return null;
    this.items[index] = { ...this.items[index], ...data };
    return { ...this.items[index] };
  }

  async delete(id: string): Promise<boolean> {
    const index = this.items.findIndex(i => i.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }

  async countProjectsUsing(_typeId: string): Promise<number> {
    // Dormant until scheduling-projects-enrich adds Project.typeId
    return 0;
  }
}
