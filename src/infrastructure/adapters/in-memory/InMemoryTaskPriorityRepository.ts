import { randomUUID } from 'crypto';
import { TaskPriority } from '@domain/entities/taskPriority';
import { TaskPriorityRepository } from '@domain/ports/TaskPriorityRepository';

export class InMemoryTaskPriorityRepository implements TaskPriorityRepository {
  private items: TaskPriority[] = [];
  /** Test seam: tasks-per-priority-name counts for the DeleteTaskPriority guard. */
  public taskCounts: Record<string, number> = {};

  async list(): Promise<TaskPriority[]> {
    return [...this.items].sort((a, b) => a.weight - b.weight).map(i => ({ ...i }));
  }

  async getById(id: string): Promise<TaskPriority | null> {
    const item = this.items.find(i => i.id === id);
    return item ? { ...item } : null;
  }

  async getByName(name: string): Promise<TaskPriority | null> {
    const item = this.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    return item ? { ...item } : null;
  }

  async create(data: { name: string; color: string; weight: number }): Promise<TaskPriority> {
    const item: TaskPriority = { id: randomUUID(), ...data };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, data: Partial<{ name: string; color: string; weight: number }>): Promise<TaskPriority | null> {
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

  async countTasksUsing(priorityName: string): Promise<number> {
    return this.taskCounts[priorityName] ?? 0;
  }
}
