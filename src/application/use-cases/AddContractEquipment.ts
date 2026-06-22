import { randomUUID } from 'crypto';
import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import { StockLocationRepository } from '@domain/ports/StockLocationRepository';
import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { InventoryMovementRepository } from '@domain/ports/InventoryMovementRepository';
import { UnitOfWork, TransactionalRepos } from '@domain/ports/UnitOfWork';
import { ContractInstalledItem, InstalledItemType } from '@domain/entities/contract-installed-item';
import { InstalledItemDto, toInstalledItemDto } from '@application/dto/InstalledItemDto';
import { ResolveClientLocation } from '@application/use-cases/ResolveClientLocation';
import { InstallContractAsset, InstallBag } from '@application/services/InstallContractAsset';
import { matchEquipment } from '@application/services/matchEquipment';
import {
  SameTypeNeedsDecisionError,
  SameTypeCandidate,
  InstalledItemNotFoundError,
} from '@domain/errors/inventory';

export interface AddContractEquipmentInput {
  contractId: string;
  type: InstalledItemType;
  serialNumber?: string | null;
  mac?: string | null;
  model?: string | null;
  notes?: string | null;
  addedByUserId?: string | null;
  /** Operator chose to complete THIS existing item (resolves a same_type decision). */
  completeItemId?: string | null;
  /** Operator chose "add new" despite a same_type match. */
  force?: boolean;
}

export interface AddContractEquipmentResult {
  /** true → a new row was created (HTTP 201); false → an existing item was enriched (HTTP 200). */
  created: boolean;
  item: InstalledItemDto;
}

/**
 * Dedup-aware contract equipment add (Cambio A). Replaces the old direct-add use
 * case whose bug was an unconditional INSERT (assetId null, no dedup, no tx). This
 * use case wires the direct add ("Agregar por PPPoE" + "+ Agregar SN") into the same
 * dedup (`matchEquipment`) + dual-write (`InstallContractAsset`) + atomic (`UnitOfWork`)
 * machinery the task-suggestion confirm already uses.
 *
 * Precedence (design Decisión 1/3):
 *   1. same_device           → enrich + revive the existing item (200)
 *   2. completeItemId         → enrich + revive that specific item (200)  [operator picked it]
 *   3. same_type && !force    → SameTypeNeedsDecisionError (409, operator decides)
 *   4. else (force | no match)→ create + dual-write asset (201)
 *
 * same_device ALWAYS wins (physical identity beats completeItemId/force).
 *
 * Dual-write deps (locations/assets/movements/uow/install) are OPTIONAL so legacy
 * call sites without the ledger still create the bare CII (assetId null), mirroring
 * ConfirmInventorySuggestion.
 */
export class AddContractEquipment {
  private readonly resolveClientLocation?: ResolveClientLocation;
  private readonly install: InstallContractAsset;

  constructor(
    private readonly inventory: ContractInventoryRepository,
    private readonly catalog: DeviceTypeCatalogRepository,
    private readonly locations?: StockLocationRepository,
    private readonly assets?: InventoryAssetRepository,
    private readonly movements?: InventoryMovementRepository,
    private readonly uow?: UnitOfWork,
    install?: InstallContractAsset,
  ) {
    if (locations) this.resolveClientLocation = new ResolveClientLocation(locations);
    this.install = install ?? new InstallContractAsset(catalog);
  }

  async execute(input: AddContractEquipmentInput): Promise<AddContractEquipmentResult> {
    const serialNumber = input.serialNumber ?? null;
    const mac = input.mac ?? null;
    const model = input.model ?? null;
    const notes = input.notes ?? null;
    const addedByUserId = input.addedByUserId ?? null;

    const items = await this.inventory.listByContract(input.contractId);
    const match = matchEquipment({ type: input.type, serialNumber, mac }, items);

    // 1) same_device → enrich the matched item (wins over completeItemId/force).
    if (match.status === 'same_device') {
      return this.enrich(match.item!, input.contractId, input.type, serialNumber, mac, model, notes, addedByUserId);
    }

    // 2) completeItemId → operator chose to complete a specific (same_type) item.
    if (input.completeItemId) {
      const target = items.find((i) => i.id === input.completeItemId);
      if (!target) throw new InstalledItemNotFoundError(input.completeItemId);
      return this.enrich(target, input.contractId, input.type, serialNumber, mac, model, notes, addedByUserId);
    }

    // 3) same_type without a decision → 409 (operator decides in the modal).
    if (match.status === 'same_type' && !input.force) {
      const candidates = items
        .filter((i) => i.status === 'active' || i.status === 'removed')
        .filter((i) => (i.type ?? '').trim().toUpperCase() === input.type.trim().toUpperCase())
        .map(toCandidate);
      throw new SameTypeNeedsDecisionError(candidates);
    }

    // 4) create + dual-write.
    return this.create(input.contractId, input.type, serialNumber, mac, model, notes, addedByUserId);
  }

  /** Enrich + revive an existing item (atomic). Fills only null fields; revives if removed. */
  private async enrich(
    item: ContractInstalledItem,
    contractId: string,
    type: string,
    serialNumber: string | null,
    mac: string | null,
    model: string | null,
    notes: string | null,
    addedByUserId: string | null,
  ): Promise<AddContractEquipmentResult> {
    const updated = await this.runUnit(async (b) => {
      // COALESCE-style patch: only fill fields that are currently null.
      const patch: Partial<ContractInstalledItem> = {};
      if (item.serialNumber == null && serialNumber != null) patch.serialNumber = serialNumber;
      if (item.mac == null && mac != null) patch.mac = mac;
      if (item.model == null && model != null) patch.model = model;
      if (item.notes == null && notes != null) patch.notes = notes;
      // Revive a removed item.
      if (item.status === 'removed') patch.status = 'active';

      // Reconcile the asset (revive/create) so the enriched equipment stays traceable.
      const assetId = await this.install.reconcileForEnrich(b, {
        assetId: item.assetId,
        contractId,
        type,
        serialNumber: item.serialNumber ?? serialNumber,
        mac: item.mac ?? mac,
        source: item.source,
        sourceTaskId: item.sourceTaskId,
        taskId: null,
        technicianId: addedByUserId,
      });
      if (assetId && item.assetId == null) patch.assetId = assetId;

      const result = await b.inventory.update(item.id, patch);
      return result ?? item;
    });

    return { created: false, item: toInstalledItemDto(updated, null) };
  }

  /** Create a brand-new item + dual-write asset + INSTALL movement (atomic). */
  private async create(
    contractId: string,
    type: string,
    serialNumber: string | null,
    mac: string | null,
    model: string | null,
    notes: string | null,
    addedByUserId: string | null,
  ): Promise<AddContractEquipmentResult> {
    const now = new Date().toISOString();
    const created = await this.runUnit(async (b) => {
      const assetId = await this.install.installNew(b, {
        contractId,
        type,
        serialNumber,
        mac,
        source: 'MANUAL',
        sourceTaskId: null,
        taskId: null,
        technicianId: addedByUserId,
      });
      return b.inventory.create({
        id: randomUUID(),
        contractId,
        type,
        serialNumber,
        mac,
        model,
        source: 'MANUAL',
        sourceTaskId: null,
        addedByUserId,
        confirmedAt: now,
        status: 'active',
        notes,
        replacesItemId: null,
        assetId,
        createdAt: now,
        updatedAt: now,
      });
    });

    return { created: true, item: toInstalledItemDto(created, null) };
  }

  /**
   * Tx-scoped repo bag for the dual-write helpers. With a UnitOfWork the bag is the
   * tx-scoped repos; otherwise the standalone constructor repos.
   */
  private bag(repos?: TransactionalRepos): InstallBag & { inventory: ContractInventoryRepository } {
    if (repos) {
      return {
        inventory: repos.inventory,
        locations: repos.locations,
        assets: repos.assets,
        movements: repos.movements,
        resolveClientLocation: new ResolveClientLocation(repos.locations),
      };
    }
    return {
      inventory: this.inventory,
      locations: this.locations,
      assets: this.assets,
      movements: this.movements,
      resolveClientLocation: this.resolveClientLocation,
    };
  }

  /** Runs `fn` inside the UnitOfWork transaction when wired; otherwise on standalone repos. */
  private async runUnit<T>(
    fn: (b: ReturnType<AddContractEquipment['bag']>) => Promise<T>,
  ): Promise<T> {
    if (this.uow) {
      return this.uow.runInTransaction((repos) => fn(this.bag(repos)));
    }
    return fn(this.bag());
  }
}

function toCandidate(i: ContractInstalledItem): SameTypeCandidate {
  return { id: i.id, type: i.type, serialNumber: i.serialNumber, mac: i.mac, model: i.model };
}
