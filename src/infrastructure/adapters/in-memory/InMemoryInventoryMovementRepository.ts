import {
  InventoryMovementRepository,
  RecordMovementInput,
  MovementFilters,
} from '@domain/ports/InventoryMovementRepository';
import { createInventoryMovement, InventoryMovement } from '@domain/entities/inventory-movement';
import { computeAssetEffect } from '@domain/entities/inventory-asset-effect';
import { InMemoryInventoryAssetRepository } from './InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from './InMemoryMaterialStockRepository';
import { randomUUID } from 'crypto';

/**
 * In-memory mirror of the atomic ledger primitive. `record()` validates the
 * movement shape (XOR + qty>0 via createInventoryMovement) AND computes the
 * resulting balance BEFORE mutating anything. If any guard fails (bad shape,
 * insufficient stock), it throws before touching the movement list OR the
 * balance stores → tests observe all-or-nothing without a real DB.
 */
export class InMemoryInventoryMovementRepository implements InventoryMovementRepository {
  readonly movements: InventoryMovement[] = [];

  constructor(
    private readonly assets: InMemoryInventoryAssetRepository,
    private readonly materials: InMemoryMaterialStockRepository,
  ) {}

  async record(input: RecordMovementInput): Promise<InventoryMovement> {
    // 0) L2 idempotency (EPIC #38 W4): mirror the PARTIAL UNIQUE on sourceRef. A
    //    re-record with an already-used sourceRef resolves to the EXISTING movement
    //    (idempotent no-op) WITHOUT re-applying the balance effect — exactly what the
    //    Prisma adapter does after catching P2002. NULL sourceRefs never collide.
    if (input.sourceRef != null) {
      const existing = this.movements.find((m) => m.sourceRef === input.sourceRef);
      if (existing) return existing;
    }

    // 1) Validate the movement shape (XOR + qty>0). Throws before any mutation.
    const movement = createInventoryMovement({
      id: randomUUID(),
      type: input.type,
      assetId: input.assetId ?? null,
      materialCatalogId: input.materialCatalogId ?? null,
      qty: input.qty ?? null,
      fromLocationId: input.fromLocationId ?? null,
      toLocationId: input.toLocationId ?? null,
      taskId: input.taskId ?? null,
      technicianId: input.technicianId ?? null,
      source: input.source,
      note: input.note ?? null,
      occurredAt: input.occurredAt ?? null,
      status: input.status ?? null,
      sourceRef: input.sourceRef ?? null,
    });

    // 2) Apply the balance effect atomically. Material decrements run their
    //    own negative guard (InsufficientStockError) BEFORE any write, so a
    //    rejected CONSUME never appends a ledger row.
    if (movement.assetId) {
      await this.applyAssetEffect(movement);
    } else {
      await this.applyMaterialEffect(movement);
    }

    // 3) Only on success append the immutable ledger row.
    this.movements.push(movement);
    return movement;
  }

  private async applyAssetEffect(mv: InventoryMovement): Promise<void> {
    const assetId = mv.assetId!;
    // SINGLE source of truth — same pure function the Prisma adapter uses (Fix #3).
    const effect = computeAssetEffect(mv);
    if (effect.currentLocationId) await this.assets.updateLocation(assetId, effect.currentLocationId);
    if (effect.status) await this.assets.updateStatus(assetId, effect.status);
  }

  private async applyMaterialEffect(mv: InventoryMovement): Promise<void> {
    const materialId = mv.materialCatalogId!;
    const qty = mv.qty!;
    switch (mv.type) {
      case 'CONSUME':
      case 'ISSUE':
        // decrement at fromLocation — guard throws BEFORE any write
        await this.materials.decrement(materialId, mv.fromLocationId!, qty);
        break;
      case 'TRANSFER':
        // decrement source first (guard), then increment destination
        await this.materials.decrement(materialId, mv.fromLocationId!, qty);
        await this.materials.increment(materialId, mv.toLocationId!, qty);
        break;
      case 'ADJUST':
        // ADJUST(material) = DELTA-additive (FIX W1 cardinal): record the DELTA, apply
        // it with `increment` (upsert additive). Two concurrent loads over the same base
        // both land because each is an independent increment — no lost-update window.
        // Document: "ADJUST(material) = additive delta" — the ledger row qty IS the delta.
        await this.materials.increment(materialId, mv.toLocationId!, qty);
        break;
      case 'INSTALL':
      case 'RETURN':
      default:
        // material increments at a location (e.g. restock) — additive
        if (mv.toLocationId) await this.materials.increment(materialId, mv.toLocationId, qty);
        break;
    }
  }

  async listByAsset(assetId: string): Promise<InventoryMovement[]> {
    return this.movements.filter((m) => m.assetId === assetId);
  }

  async findBySourceRef(sourceRef: string): Promise<InventoryMovement | null> {
    return this.movements.find((m) => m.sourceRef === sourceRef) ?? null;
  }

  /**
   * Wave 7 (Capstone) — paginated movement ledger, ordered occurredAt DESC.
   * Parity with PrismaInventoryMovementRepository: same filter logic, same order.
   */
  async listMovements(
    filters: MovementFilters,
    page: number,
    limit: number,
  ): Promise<{ items: InventoryMovement[]; total: number }> {
    let filtered = [...this.movements];

    if (filters.type) {
      filtered = filtered.filter((m) => m.type === filters.type);
    }
    if (filters.locationId) {
      filtered = filtered.filter(
        (m) => m.fromLocationId === filters.locationId || m.toLocationId === filters.locationId,
      );
    }
    if (filters.materialCatalogId) {
      filtered = filtered.filter((m) => m.materialCatalogId === filters.materialCatalogId);
    }
    if (filters.taskId) {
      filtered = filtered.filter((m) => m.taskId === filters.taskId);
    }
    if (filters.technicianId) {
      filtered = filtered.filter((m) => m.technicianId === filters.technicianId);
    }
    if (filters.dateFrom) {
      const from = new Date(filters.dateFrom).getTime();
      filtered = filtered.filter((m) => new Date(m.occurredAt).getTime() >= from);
    }
    if (filters.dateTo) {
      const to = new Date(filters.dateTo).getTime();
      filtered = filtered.filter((m) => new Date(m.occurredAt).getTime() <= to);
    }

    // occurredAt DESC
    filtered.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

    const total = filtered.length;
    const offset = (page - 1) * limit;
    const items = filtered.slice(offset, offset + limit);

    return { items, total };
  }
}
