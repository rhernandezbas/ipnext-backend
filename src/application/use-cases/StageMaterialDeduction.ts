import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { MaterialStockRepository } from '@domain/ports/MaterialStockRepository';
import { MaterialDeductionSuggestionRepository } from '@domain/ports/MaterialDeductionSuggestionRepository';
import {
  MaterialDeductionSuggestion,
  MaterialDeductionStatus,
  createMaterialDeductionSuggestion,
} from '@domain/entities/material-deduction-suggestion';
import { roundQty } from '@domain/entities/material-stock';
import { ResolveTechnicianLocation } from '@application/use-cases/ResolveTechnicianLocation';
import { randomUUID } from 'crypto';

const FLAG_KEY = 'inventory-material-auto-deduct';

export interface StageMaterialDeductionInput {
  consumptionId: string;
  taskId: string;
  /** Null when the ScheduledTask has no assigneeId. */
  technicianId: string | null;
  materialCatalogId: string;
  qty: number;
}

/**
 * StageMaterialDeduction — flag-gated, READ-ONLY hook (EPIC #38 W6).
 *
 * Called from BOTH consumption channels (RecordMaterialConsumption and
 * ConfirmInventorySuggestion.handleMaterial) immediately after the consumption
 * row is created. NEVER mutates stock.
 *
 * Logic:
 *   - Flag OFF → return null (no suggestion created; consumption write stands).
 *   - L1 dedup: `findByConsumptionId` → return existing suggestion if already staged.
 *   - No assignee → `needs_review`.
 *   - Resolve assignee's TECNICO location (find-or-create). If tech has no location
 *     yet this creates it idempotently (the W5a pattern).
 *   - Check MaterialStock.qty at the TECNICO location:
 *       qty >= consumption qty → `pending`
 *       qty <  consumption qty (or no stock row) → `needs_review`
 *   - Create and return the suggestion.
 *
 * Staging failures MUST NOT abort the caller's consumption write — callers are
 * responsible for wrapping this in a try/catch (best-effort hook, like W4's stage).
 */
export class StageMaterialDeduction {
  constructor(
    private readonly flags: FeatureFlagRepository,
    private readonly stock: MaterialStockRepository,
    private readonly deductions: MaterialDeductionSuggestionRepository,
    private readonly resolveLocation: ResolveTechnicianLocation,
  ) {}

  async execute(
    input: StageMaterialDeductionInput,
  ): Promise<MaterialDeductionSuggestion | null> {
    // ── Flag gate ─────────────────────────────────────────────────────────────
    const flag = await this.flags.get(FLAG_KEY);
    if (!flag?.enabled) return null;

    // ── L1 dedup ──────────────────────────────────────────────────────────────
    const existing = await this.deductions.findByConsumptionId(input.consumptionId);
    if (existing) return existing;

    // ── Resolve location + stock ───────────────────────────────────────────────
    let technicianLocationId: string | null = null;
    let status: MaterialDeductionStatus = 'pending';

    if (!input.technicianId) {
      status = 'needs_review';
    } else {
      const loc = await this.resolveLocation.execute(input.technicianId);
      technicianLocationId = loc.id;

      const stockRow = await this.stock.findByMaterialAndLocation(
        input.materialCatalogId,
        loc.id,
      );
      const availableQty = stockRow?.qty ?? 0;
      if (availableQty < roundQty(input.qty)) {
        status = 'needs_review';
      }
    }

    // ── Create suggestion ──────────────────────────────────────────────────────
    const suggestion = createMaterialDeductionSuggestion({
      id: randomUUID(),
      taskMaterialConsumptionId: input.consumptionId,
      taskId: input.taskId,
      technicianId: input.technicianId,
      materialCatalogId: input.materialCatalogId,
      qty: input.qty,
      technicianLocationId,
      status,
    });

    return this.deductions.create(suggestion);
  }
}
