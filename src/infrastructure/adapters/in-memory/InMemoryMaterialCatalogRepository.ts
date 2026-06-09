import { randomUUID } from 'crypto';
import { MaterialCatalog } from '@domain/entities/material-catalog';
import { MaterialCatalogRepository, LowStockAlertDTO } from '@domain/ports/MaterialCatalogRepository';
import { InMemoryMaterialStockRepository } from './InMemoryMaterialStockRepository';

export class InMemoryMaterialCatalogRepository implements MaterialCatalogRepository {
  private items: MaterialCatalog[] = [];
  /** Test seam: consumption-records-per-material-id counts for the DeleteMaterial guard. */
  public usageCounts: Record<string, number> = {};
  /**
   * Optional: inject a stock repository to enable listLowStock() aggregation.
   * Without it, listLowStock() returns [] (no stock data available).
   */
  public stockRepo?: InMemoryMaterialStockRepository;

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

  async create(data: { name: string; label?: string | null; unit?: string | null; active?: boolean; sortOrder?: number; minStock?: number }): Promise<MaterialCatalog> {
    const item: MaterialCatalog = {
      id: randomUUID(),
      name: data.name,
      label: data.label ?? null,
      unit: data.unit ?? null,
      active: data.active ?? true,
      sortOrder: data.sortOrder ?? 0,
      minStock: data.minStock ?? 0,
    };
    this.items.push(item);
    return { ...item };
  }

  async update(id: string, data: Partial<{ name: string; label: string | null; unit: string | null; active: boolean; sortOrder: number; minStock: number }>): Promise<MaterialCatalog | null> {
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

  /**
   * Wave 7 (Capstone) — returns materials where minStock > 0 AND SUM(qty) < minStock.
   * Requires stockRepo to be set; returns [] otherwise (no stock data in-memory).
   * Parity with PrismaMaterialCatalogRepository.listLowStock().
   */
  async listLowStock(): Promise<LowStockAlertDTO[]> {
    const materialsWithThreshold = this.items.filter(i => i.minStock > 0);
    if (materialsWithThreshold.length === 0 || !this.stockRepo) return [];

    const alerts: LowStockAlertDTO[] = [];

    for (const mat of materialsWithThreshold) {
      // Sum all stock rows for this material across all locations
      const allStock = Array.from(this.stockRepo.store.values()).filter(
        (s) => s.materialCatalogId === mat.id,
      );
      const totalQty = allStock.reduce((sum, s) => sum + s.qty, 0);

      if (totalQty < mat.minStock) {
        alerts.push({
          materialCatalogId: mat.id,
          name: mat.name,
          label: mat.label,
          unit: mat.unit,
          totalQty,
          minStock: mat.minStock,
          deficit: mat.minStock - totalQty,
        });
      }
    }

    return alerts;
  }
}
