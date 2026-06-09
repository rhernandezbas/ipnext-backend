export interface TaskMaterialConsumption {
  id: string;
  taskId: string;
  materialCatalogId: string;
  materialName: string;        // snapshot
  quantity: number;
  unit: string | null;
  notes: string | null;
  recordedByUserId: string | null;
  // EPIC #38 W6 — link to the deduction movement. null = not yet deducted.
  deductedAt: Date | null;
  deductedMovementId: string | null;
  createdAt: string;
  updatedAt: string;
}
