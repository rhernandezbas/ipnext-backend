import { randomUUID } from 'crypto';
import { TaskCategory } from '@domain/entities/taskCategory';
import { TaskCategoryRepository } from '@domain/ports/TaskCategoryRepository';

export class InMemoryTaskCategoryRepository implements TaskCategoryRepository {
  private items: TaskCategory[] = [];
  /** Test seam: tasks-per-category-name counts, so DeleteTaskCategory guard can be exercised. */
  public taskCounts: Record<string, number> = {};

  async list(): Promise<TaskCategory[]> {
    return this.items.map(i => ({ ...i }));
  }

  async getById(id: string): Promise<TaskCategory | null> {
    const item = this.items.find(i => i.id === id);
    return item ? { ...item } : null;
  }

  async getByName(name: string): Promise<TaskCategory | null> {
    const item = this.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    return item ? { ...item } : null;
  }

  async create(data: { name: string; description: string | null }): Promise<TaskCategory> {
    const item: TaskCategory = { id: randomUUID(), name: data.name, description: data.description };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, data: Partial<{ name: string; description: string | null }>): Promise<TaskCategory | null> {
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

  async countTasksUsing(categoryName: string): Promise<number> {
    return this.taskCounts[categoryName] ?? 0;
  }
}
