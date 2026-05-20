import { randomUUID } from 'crypto';
import { ProjectCategory } from '@domain/entities/projectCategory';
import { ProjectCategoryRepository } from '@domain/ports/ProjectCategoryRepository';

export class InMemoryProjectCategoryRepository implements ProjectCategoryRepository {
  private items: ProjectCategory[] = [];

  async list(): Promise<ProjectCategory[]> {
    return this.items.map(i => ({ ...i }));
  }

  async getById(id: string): Promise<ProjectCategory | null> {
    const item = this.items.find(i => i.id === id);
    return item ? { ...item } : null;
  }

  async getByName(name: string): Promise<ProjectCategory | null> {
    const item = this.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    return item ? { ...item } : null;
  }

  async create(data: { name: string; description: string | null }): Promise<ProjectCategory> {
    const item: ProjectCategory = { id: randomUUID(), name: data.name, description: data.description };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, data: Partial<{ name: string; description: string | null }>): Promise<ProjectCategory | null> {
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

  async countProjectsUsing(_categoryId: string): Promise<number> {
    // Dormant until scheduling-projects-enrich adds Project.categoryId
    return 0;
  }
}
