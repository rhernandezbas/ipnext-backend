export interface TaskMaterialConsumption {
  id: string;
  taskId: string;
  materialCatalogId: string;
  materialName: string;        // snapshot
  quantity: number;
  unit: string | null;
  notes: string | null;
  recordedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}
