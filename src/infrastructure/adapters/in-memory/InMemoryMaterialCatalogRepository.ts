import { randomUUID } from 'crypto';
import { MaterialCatalog } from '@domain/entities/material-catalog';
import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';

export class InMemoryMaterialCatalogRepository implements MaterialCatalogRepository {
  private items: MaterialCatalog[] = [];
  /** Test seam: consumption-records-per-material-id counts for the DeleteMaterial guard. */
  public usageCounts: Record<string, number> = {};

  async list(): Promise<MaterialCatalog[]> {
    return [...this.items].sort((a, b) => a.sortOrder - b.sortOrder).map(i => ({ ...i }));
  }

  async getById(id: string): Promise<MaterialCatalog | null> {
    const item = this.items.find(i => i.id === id);
    return item ? { ...item } : null;
  }

  async getByName(name: string): Promise<MaterialCatalog | null> {
    const item = this.items.find(i => i.name.toLowerCase() === name.toLowerCase());
    return item ? { ...item } : null;
  }

  async create(data: { name: string; label?: string | null; unit?: string | null; active?: boolean; sortOrder?: number }): Promise<MaterialCatalog> {
    const item: MaterialCatalog = {
      id: randomUUID(),
      name: data.name,
      label: data.label ?? null,
      unit: data.unit ?? null,
      active: data.active ?? true,
      sortOrder: data.sortOrder ?? 0,
    };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, data: Partial<{ name: string; label: string | null; unit: string | null; active: boolean; sortOrder: number }>): Promise<MaterialCatalog | null> {
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

  async countInUse(materialId: string): Promise<number> {
    return this.usageCounts[materialId] ?? 0;
  }

  async listActiveNames(): Promise<string[]> {
    return this.items
      .filter(i => i.active)
      .map(i => i.name.toUpperCase());
  }
}
