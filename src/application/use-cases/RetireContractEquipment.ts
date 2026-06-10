import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { InventoryMovementRepository } from '@domain/ports/InventoryMovementRepository';
import { UnitOfWork, TransactionalRepos } from '@domain/ports/UnitOfWork';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import {
  TaskHasNoContractError,
  ProjectNotRetirementError,
  EquipmentNotOnContractError,
  RetireAlreadyDoneError,
} from '@domain/errors/inventory';
import { DomainError } from '@domain/errors/index';

export interface RetireContractEquipmentInput {
  taskId: string;
  itemIds: string[];
  actorId: string | null;
}

export interface RetiredItemDTO {
  itemId: string;
  status: 'removed';
  assetId: string | null;
  movementId: string | null;
}

export interface RetireContractEquipmentResult {
  retired: RetiredItemDTO[];
  skipped: { itemId: string; reason: 'already-removed' }[];
}

/**
 * RetireContractEquipment (#39) — manually retire N installed items from the task's contract.
 *
 * Guards (cascade):
 *  1. itemIds non-empty  → 400 VALIDATION_ERROR
 *  2. task.contractId    → 422 TASK_HAS_NO_CONTRACT
 *  3. project.allowsEquipmentRetirement → 422 PROJECT_NOT_RETIREMENT
 *
 * Inside ONE runInTransaction per call:
 *   for ciiId in itemIds:
 *     - getById(ciiId): must belong to contractId else 422 EQUIPMENT_NOT_ON_CONTRACT
 *     - if cii.status !== 'active': skip (idempotent — already removed)
 *     - remove(ciiId) → status=removed
 *     - if cii.assetId:
 *       - findBySourceRef(sourceRef) → if exists: 409 RETIRE_ALREADY_DONE
 *       - movements.record(RETURN, asset → DEPOSITO, source='MANUAL', sourceRef)
 *
 * sourceRef = `manual:retire:{taskId}:{ciiId}` (keyed by task+CII, not asset — idempotency key)
 */
export class RetireContractEquipment {
  constructor(
    private readonly scheduling: SchedulingRepository,
    private readonly contractInventory: ContractInventoryRepository,
    private readonly assets: InventoryAssetRepository,
    private readonly movements: InventoryMovementRepository,
    private readonly resolveDepot: ResolveDepotLocation,
    private readonly uow?: UnitOfWork,
  ) {}

  async execute(input: RetireContractEquipmentInput): Promise<RetireContractEquipmentResult> {
    // Guard 1: non-empty itemIds
    if (input.itemIds.length === 0) {
      throw new DomainError('itemIds must not be empty', 'VALIDATION_ERROR');
    }

    // Guard 2: task must have a contract
    const task = await this.scheduling.getTask(input.taskId);
    if (!task) {
      throw new DomainError(`Task ${input.taskId} not found`, 'TASK_NOT_FOUND');
    }
    if (!task.contractId) {
      throw new TaskHasNoContractError(input.taskId);
    }

    // Guard 3: project must allow retirement
    if (!task.projectAllowsRetirement) {
      throw new ProjectNotRetirementError(task.projectId ?? input.taskId);
    }

    const contractId = task.contractId;

    return this.runUnit(async (b) => {
      const retired: RetiredItemDTO[] = [];
      const skipped: { itemId: string; reason: 'already-removed' }[] = [];

      const depot = await this.resolveDepot.execute('DEPOSITO');

      for (const ciiId of input.itemIds) {
        // Validate CII belongs to the task's contract
        const cii = await b.inventory.getById(ciiId);
        if (!cii || cii.contractId !== contractId) {
          throw new EquipmentNotOnContractError(ciiId);
        }

        // Idempotent skip: already removed
        if (cii.status !== 'active') {
          skipped.push({ itemId: ciiId, reason: 'already-removed' });
          continue;
        }

        // Remove CII (soft delete → status = removed)
        await b.inventory.remove(ciiId);

        let movementId: string | null = null;

        if (cii.assetId) {
          const sourceRef = `manual:retire:${input.taskId}:${ciiId}`;

          // Pre-write idempotency check (L2 guard)
          const existing = await b.movements.findBySourceRef(sourceRef);
          if (existing) {
            throw new RetireAlreadyDoneError(ciiId);
          }

          // Only move if asset is currently installed (graceful skip if already in depot)
          const asset = await b.assets.findById(cii.assetId);
          if (asset && asset.status === 'installed') {
            const movement = await b.movements.record({
              type: 'RETURN',
              assetId: cii.assetId,
              toLocationId: depot.id,
              taskId: input.taskId,
              source: 'MANUAL',
              sourceRef,
            });
            movementId = movement.id;
          }
          // else: asset not installed → skip movement gracefully (CII still removed)
        }

        retired.push({
          itemId: ciiId,
          status: 'removed',
          assetId: cii.assetId,
          movementId,
        });
      }

      return { retired, skipped };
    });
  }

  private async runUnit(
    fn: (b: {
      inventory: ContractInventoryRepository;
      assets: InventoryAssetRepository;
      movements: InventoryMovementRepository;
    }) => Promise<RetireContractEquipmentResult>,
  ): Promise<RetireContractEquipmentResult> {
    if (this.uow) {
      return this.uow.runInTransaction((repos: TransactionalRepos) =>
        fn({
          inventory: repos.inventory,
          assets: repos.assets,
          movements: repos.movements,
        }),
      );
    }
    return fn({
      inventory: this.contractInventory,
      assets: this.assets,
      movements: this.movements,
    });
  }
}
