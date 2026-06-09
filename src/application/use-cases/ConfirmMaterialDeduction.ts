import { MaterialDeductionSuggestionRepository } from '@domain/ports/MaterialDeductionSuggestionRepository';
import { TaskMaterialConsumptionRepository } from '@domain/ports/TaskMaterialConsumptionRepository';
import { InventoryMovementRepository } from '@domain/ports/InventoryMovementRepository';
import { MaterialStockRepository } from '@domain/ports/MaterialStockRepository';
import { StockLocationRepository } from '@domain/ports/StockLocationRepository';
import { UnitOfWork, TransactionalRepos } from '@domain/ports/UnitOfWork';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { MaterialDeductionSuggestion, deductionSourceRef } from '@domain/entities/material-deduction-suggestion';
import {
  DeductionSuggestionNotFoundError,
  DeductionAlreadyConfirmedError,
  DeductionHasNoTechnicianError,
} from '@domain/errors/inventory';

export type DeductionResolution = 'deduct' | 'issue-first' | 'depot' | 'discard';

export interface ConfirmMaterialDeductionInput {
  suggestionId: string;
  resolution: DeductionResolution;
}

/**
 * ConfirmMaterialDeduction — the ONLY stock mutation of the W6 material-deduction flow.
 *
 * Operator-driven. Runs inside a UnitOfWork (atomic):
 *   1. L1: terminal-status guard → 409.
 *   2. Pre-write `findBySourceRef('consume:task-material:{consumptionId}')` → 409.
 *   3. TOCTOU re-check MaterialStock.qty INSIDE the tx — short → flip to needs_review, no movement.
 *   4. RecordInventoryMovement(CONSUME, fromLocationId=tecnico, mat, qty).
 *   5. Stamp consumption.deductedAt / deductedMovementId.
 *   6. Set suggestion confirmed.
 *
 * needs_review resolutions (all atomic in the tx):
 *   - `issue-first`: TRANSFER depot→tecnico + CONSUME from tecnico (net depot−qty, tecnico unchanged).
 *   - `depot`:       CONSUME directly from depot.
 *   - `discard`:     no movement; suggestion → discarded.
 */
export class ConfirmMaterialDeduction {
  constructor(
    private readonly deductions: MaterialDeductionSuggestionRepository,
    private readonly consumptions: TaskMaterialConsumptionRepository,
    private readonly movements: InventoryMovementRepository,
    private readonly stock: MaterialStockRepository,
    private readonly locations: StockLocationRepository,
    private readonly resolveDepot: ResolveDepotLocation,
    private readonly uow?: UnitOfWork,
  ) {}

  async execute(input: ConfirmMaterialDeductionInput): Promise<MaterialDeductionSuggestion> {
    const suggestion = await this.deductions.findById(input.suggestionId);
    if (!suggestion) throw new DeductionSuggestionNotFoundError(input.suggestionId);

    // L1: terminal-status guard
    if (suggestion.status === 'confirmed' || suggestion.status === 'discarded') {
      throw new DeductionAlreadyConfirmedError(suggestion.id, suggestion.status);
    }

    if (input.resolution === 'discard') {
      const updated = await this.deductions.updateStatus(suggestion.id, {
        status: 'discarded',
        resolution: 'discard',
      });
      if (!updated) throw new DeductionAlreadyConfirmedError(suggestion.id, suggestion.status);
      return updated;
    }

    const sourceRef = deductionSourceRef(suggestion.taskMaterialConsumptionId);

    return this.runUnit(async (b) => {
      // L2 idempotency: pre-write check before any mutation
      const existing = await b.movements.findBySourceRef(sourceRef);
      if (existing) {
        throw new DeductionAlreadyConfirmedError(suggestion.id, 'confirmed');
      }

      if (input.resolution === 'depot') {
        return this.handleDepot(suggestion, sourceRef, b);
      }

      if (input.resolution === 'issue-first') {
        return this.handleIssueFirst(suggestion, sourceRef, b);
      }

      // Default: deduct from technician's TECNICO location
      return this.handleDeduct(suggestion, sourceRef, b);
    });
  }

  private async handleDeduct(
    suggestion: MaterialDeductionSuggestion,
    sourceRef: string,
    b: TransactionalBag,
  ): Promise<MaterialDeductionSuggestion> {
    const techLocationId = suggestion.technicianLocationId;
    if (!techLocationId) {
      // No location → flip to needs_review (should not happen in normal flow)
      const nr1 = await b.deductions!.updateStatus(suggestion.id, { status: 'needs_review' });
      if (!nr1) throw new DeductionAlreadyConfirmedError(suggestion.id, suggestion.status);
      return nr1;
    }

    // TOCTOU re-check INSIDE the tx
    const stockRow = await b.stock!.findByMaterialAndLocation(
      suggestion.materialCatalogId,
      techLocationId,
    );
    const available = stockRow?.qty ?? 0;
    if (available < suggestion.qty) {
      // Flip to needs_review; no movement written
      const nr2 = await b.deductions!.updateStatus(suggestion.id, { status: 'needs_review' });
      if (!nr2) throw new DeductionAlreadyConfirmedError(suggestion.id, suggestion.status);
      return nr2;
    }

    // Record CONSUME movement
    const movement = await b.movements.record({
      type: 'CONSUME',
      materialCatalogId: suggestion.materialCatalogId,
      qty: suggestion.qty,
      fromLocationId: techLocationId,
      taskId: suggestion.taskId,
      source: 'ICLASS_MATERIAL',
      sourceRef,
    });

    // Stamp the consumption
    const deductedAt = new Date();
    if (b.consumptions) {
      await b.consumptions.stampDeduction(
        suggestion.taskMaterialConsumptionId,
        deductedAt,
        movement.id,
      );
    }

    // Confirm suggestion — null means the terminal guard fired (concurrent race loser)
    const updated = await b.deductions!.updateStatus(suggestion.id, {
      status: 'confirmed',
      resolution: 'deduct',
      sourceRef,
      deductedMovementId: movement.id,
    });
    if (!updated) throw new DeductionAlreadyConfirmedError(suggestion.id, 'confirmed');
    return updated;
  }

  private async handleDepot(
    suggestion: MaterialDeductionSuggestion,
    sourceRef: string,
    b: TransactionalBag,
  ): Promise<MaterialDeductionSuggestion> {
    const depot = await this.resolveDepot.execute('DEPOSITO');

    const movement = await b.movements.record({
      type: 'CONSUME',
      materialCatalogId: suggestion.materialCatalogId,
      qty: suggestion.qty,
      fromLocationId: depot.id,
      taskId: suggestion.taskId,
      source: 'ICLASS_MATERIAL',
      sourceRef,
    });

    const deductedAt = new Date();
    if (b.consumptions) {
      await b.consumptions.stampDeduction(
        suggestion.taskMaterialConsumptionId,
        deductedAt,
        movement.id,
      );
    }

    const updated = await b.deductions!.updateStatus(suggestion.id, {
      status: 'confirmed',
      resolution: 'depot',
      sourceRef,
      deductedMovementId: movement.id,
    });
    if (!updated) throw new DeductionAlreadyConfirmedError(suggestion.id, 'confirmed');
    return updated;
  }

  private async handleIssueFirst(
    suggestion: MaterialDeductionSuggestion,
    sourceRef: string,
    b: TransactionalBag,
  ): Promise<MaterialDeductionSuggestion> {
    // Fix 5: require a valid technicianLocationId. Silently falling back to
    // depot-as-source would mask the data gap and corrupt the ledger semantics
    // (issue-first means depot→tech→consume, not depot→depot→consume).
    if (!suggestion.technicianLocationId) {
      throw new DeductionHasNoTechnicianError(suggestion.id);
    }

    const depot = await this.resolveDepot.execute('DEPOSITO');
    const techLocationId = suggestion.technicianLocationId;

    // TRANSFER depot→tecnico first
    await b.movements.record({
      type: 'TRANSFER',
      materialCatalogId: suggestion.materialCatalogId,
      qty: suggestion.qty,
      fromLocationId: depot.id,
      toLocationId: techLocationId,
      taskId: suggestion.taskId,
      source: 'ICLASS_MATERIAL',
    });

    // CONSUME from tecnico
    const consumeRef = sourceRef; // same L2 key
    const movement = await b.movements.record({
      type: 'CONSUME',
      materialCatalogId: suggestion.materialCatalogId,
      qty: suggestion.qty,
      fromLocationId: techLocationId,
      taskId: suggestion.taskId,
      source: 'ICLASS_MATERIAL',
      sourceRef: consumeRef,
    });

    const deductedAt = new Date();
    if (b.consumptions) {
      await b.consumptions.stampDeduction(
        suggestion.taskMaterialConsumptionId,
        deductedAt,
        movement.id,
      );
    }

    const updated = await b.deductions!.updateStatus(suggestion.id, {
      status: 'confirmed',
      resolution: 'issue-first',
      sourceRef: consumeRef,
      deductedMovementId: movement.id,
    });
    if (!updated) throw new DeductionAlreadyConfirmedError(suggestion.id, 'confirmed');
    return updated;
  }

  private async runUnit(
    fn: (b: TransactionalBag) => Promise<MaterialDeductionSuggestion>,
  ): Promise<MaterialDeductionSuggestion> {
    if (this.uow) {
      return this.uow.runInTransaction((repos: TransactionalRepos) =>
        fn({
          movements: repos.movements,
          deductions: repos.deductions ?? this.deductions,
          consumptions: repos.consumptions ?? this.consumptions,
          // Fix 3b: use tx-scoped stock so the TOCTOU re-check in handleDeduct
          // truly reads inside the transaction (eliminates TOCTOU read-outside-tx).
          stock: repos.stock ?? this.stock,
        }),
      );
    }
    return fn({
      movements: this.movements,
      deductions: this.deductions,
      consumptions: this.consumptions,
      stock: this.stock,
    });
  }
}

/** Tx-scoped repo bag for ConfirmMaterialDeduction. */
interface TransactionalBag {
  movements: InventoryMovementRepository;
  deductions?: MaterialDeductionSuggestionRepository;
  consumptions?: TaskMaterialConsumptionRepository;
  stock?: MaterialStockRepository;
}
