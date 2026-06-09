import { InventoryMovementRepository, MovementFilters } from '@domain/ports/InventoryMovementRepository';
import { InventoryMovement } from '@domain/entities/inventory-movement';
import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { StockLocationRepository } from '@domain/ports/StockLocationRepository';
import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { InventoryMovementListDTO, MovementRowDTO } from '@application/dto/InventoryMovementListDto';

/**
 * Wave 7 (Capstone) — GET /api/inventory/movements.
 *
 * Paginated movement ledger, ordered occurredAt DESC. Filters are combinable.
 * Labels are batch-resolved by unique ids (W6 ListPendingDeductions pattern) — NO N+1.
 */
export class ListInventoryMovements {
  constructor(
    private readonly movementRepo: InventoryMovementRepository,
    private readonly materialRepo?: MaterialCatalogRepository,
    private readonly locationRepo?: StockLocationRepository,
    private readonly userRepo?: RbacUserRepository,
    private readonly schedulingRepo?: SchedulingRepository,
  ) {}

  async execute(
    filters: MovementFilters,
    page: number,
    limit: number,
  ): Promise<InventoryMovementListDTO> {
    const { items, total } = await this.movementRepo.listMovements(filters, page, limit);

    if (items.length === 0) {
      return { items: [], total, page, limit };
    }

    // ── Batch lookups by unique ids (no N+1) ─────────────────────────────────
    const materialMap = await this.buildMaterialMap(items);
    const locationMap = await this.buildLocationMap(items);
    const userMap = await this.buildUserMap(items);
    const taskMap = await this.buildTaskMap(items);

    const rows: MovementRowDTO[] = items.map((m) => {
      const mat = m.materialCatalogId ? materialMap.get(m.materialCatalogId) : null;
      const fromLoc = m.fromLocationId ? locationMap.get(m.fromLocationId) : null;
      const toLoc = m.toLocationId ? locationMap.get(m.toLocationId) : null;
      const user = m.technicianId ? userMap.get(m.technicianId) : null;
      const task = m.taskId ? taskMap.get(m.taskId) : null;

      return {
        id: m.id,
        type: m.type,
        occurredAt: m.occurredAt,
        assetId: m.assetId,
        materialCatalogId: m.materialCatalogId,
        materialName: mat?.name ?? null,
        qty: m.qty,
        fromLocationId: m.fromLocationId,
        fromLocationLabel: fromLoc ?? null,
        toLocationId: m.toLocationId,
        toLocationLabel: toLoc ?? null,
        taskId: m.taskId,
        taskSeq: task?.sequenceNumber ?? null,
        technicianId: m.technicianId,
        technicianName: user?.name ?? null,
        source: m.source,
        note: m.note,
      };
    });

    return { items: rows, total, page, limit };
  }

  private async buildMaterialMap(
    items: InventoryMovement[],
  ): Promise<Map<string, { name: string }>> {
    if (!this.materialRepo) return new Map();
    const ids = [...new Set(items.map((m) => m.materialCatalogId).filter(Boolean) as string[])];
    const entries = await Promise.all(ids.map((id) => this.materialRepo!.getById(id)));
    const map = new Map<string, { name: string }>();
    entries.forEach((mat) => { if (mat) map.set(mat.id, { name: mat.name }); });
    return map;
  }

  private async buildLocationMap(
    items: InventoryMovement[],
  ): Promise<Map<string, string | null>> {
    if (!this.locationRepo) return new Map();
    // Collect all unique location ids (from + to)
    const fromIds = items.map((m) => m.fromLocationId).filter(Boolean) as string[];
    const toIds = items.map((m) => m.toLocationId).filter(Boolean) as string[];
    const uniqueIds = [...new Set([...fromIds, ...toIds])];
    if (uniqueIds.length === 0) return new Map();

    // FIX-3: use findLabelsByIds (ANY location, including now-empty ones) instead of
    // listWithContent() which only returns locations with current content. A movement
    // referencing an emptied location would silently resolve to "—" with listWithContent.
    const labels = await this.locationRepo.findLabelsByIds(uniqueIds);
    const map = new Map<string, string | null>();
    labels.forEach((loc) => { map.set(loc.id, loc.label); });
    // Ensure all referenced location ids are present (fallback null for not-found)
    uniqueIds.forEach((id) => { if (!map.has(id)) map.set(id, null); });
    return map;
  }

  private async buildUserMap(
    items: InventoryMovement[],
  ): Promise<Map<string, { name: string }>> {
    if (!this.userRepo) return new Map();
    const ids = [...new Set(items.map((m) => m.technicianId).filter(Boolean) as string[])];
    const entries = await Promise.all(ids.map((id) => this.userRepo!.findById(id)));
    const map = new Map<string, { name: string }>();
    entries.forEach((u) => { if (u) map.set(u.id, { name: u.name }); });
    return map;
  }

  private async buildTaskMap(
    items: InventoryMovement[],
  ): Promise<Map<string, { sequenceNumber: number }>> {
    if (!this.schedulingRepo) return new Map();
    const ids = [...new Set(items.map((m) => m.taskId).filter(Boolean) as string[])];
    const entries = await Promise.all(ids.map((id) => this.schedulingRepo!.getTask(id)));
    const map = new Map<string, { sequenceNumber: number }>();
    entries.forEach((t) => { if (t) map.set(t.id, { sequenceNumber: t.sequenceNumber }); });
    return map;
  }
}
