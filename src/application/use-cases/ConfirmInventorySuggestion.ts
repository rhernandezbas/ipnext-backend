import { InventorySuggestionRepository } from '@domain/ports/InventorySuggestionRepository';
import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { TaskMaterialConsumptionRepository } from '@domain/ports/TaskMaterialConsumptionRepository';
import { StageMaterialDeduction } from '@application/use-cases/StageMaterialDeduction';
import {
  SuggestionNotFoundError,
  SuggestionAlreadyConfirmedError,
  TaskHasNoContractError,
  DuplicateInstalledItemError,
  NoReplaceTargetError,
  NotADeviceError,
} from '@domain/errors/inventory';
import { randomUUID } from 'crypto';
import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { InstalledItemDto, toInstalledItemDto } from '@application/dto/InstalledItemDto';
import { MaterialConsumptionDto, toMaterialConsumptionDto } from '@application/dto/MaterialConsumptionDto';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';
import { matchInstalledItem } from '@application/services/matchInstalledItem';
import { assertSuggestionComplete } from '@domain/services/suggestionCompleteness';
import { StockLocationRepository } from '@domain/ports/StockLocationRepository';
import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { InventoryMovementRepository } from '@domain/ports/InventoryMovementRepository';
import { ResolveClientLocation } from '@application/use-cases/ResolveClientLocation';
import { nextStatus } from '@domain/entities/inventory-asset';
import { UnitOfWork, TransactionalRepos } from '@domain/ports/UnitOfWork';
import { InstallContractAsset } from '@application/services/InstallContractAsset';

export type SuggestionResolution = 'add' | 'replace' | 'link_existing';

export interface ConfirmInventorySuggestionInput {
  suggestionId: string;
  addedByUserId?: string | null;
  /** Operator's chosen device type (from the dropdown). Overrides the suggestion's deviceType. */
  typeOverride?: string | null;
  /** How to resolve an existing-match conflict. Default: 'add'. */
  resolution?: SuggestionResolution;
}

export type ConfirmResult =
  | { kind: 'DEVICE'; item: InstalledItemDto }
  | { kind: 'MATERIAL'; consumption: MaterialConsumptionDto };

/**
 * Promotes a staged suggestion to a real ContractInstalledItem (DEVICE) or a
 * TaskMaterialConsumption (MATERIAL) on the task's contract. This is the ONLY
 * path scraped/OCR data reaches the contract, and it is operator-driven.
 * ONE suggestion → ONE item/consumption. Re-confirming is rejected.
 */
export class ConfirmInventorySuggestion {
  /** Lazily built from the locations repo; resolves/creates the contract's CLIENTE location. */
  private readonly resolveClientLocation?: ResolveClientLocation;
  /** Shared install/dual-write service (design Decisión 2). Built from `catalog`. */
  private readonly install: InstallContractAsset;

  constructor(
    private readonly suggestions: InventorySuggestionRepository,
    private readonly inventory: ContractInventoryRepository,
    private readonly scheduling: SchedulingRepository,
    private readonly users: RbacUserRepository,
    private readonly catalog: DeviceTypeCatalogRepository,
    private readonly materials: MaterialCatalogRepository,
    private readonly consumptions: TaskMaterialConsumptionRepository,
    // Inventory Foundation (W1) — dual-write deps. Optional so legacy call sites
    // (tests that don't exercise the ledger) keep working; when all three are
    // present, every DEVICE confirm also writes an InventoryAsset + INSTALL movement.
    private readonly locations?: StockLocationRepository,
    private readonly assets?: InventoryAssetRepository,
    private readonly movements?: InventoryMovementRepository,
    // Inventory Foundation (W2 Fix #1/#3) — when present, the DEVICE confirm/replace
    // dual-write (asset + INSTALL movement + CII + setStatus) runs inside ONE
    // transaction via this UnitOfWork. Optional: without it the writes run on the
    // standalone repos above (legacy behavior).
    private readonly uow?: UnitOfWork,
    // EPIC #38 W6 — optional staging hook for MATERIAL confirms. null = not wired.
    private readonly stageMaterialDeduction?: StageMaterialDeduction | null,
  ) {
    if (locations) this.resolveClientLocation = new ResolveClientLocation(locations);
    this.install = new InstallContractAsset(catalog);
  }

  /** True when the full dual-write wiring is present. */
  private get dualWriteEnabled(): boolean {
    return !!(this.resolveClientLocation && this.assets && this.movements);
  }

  /**
   * Tx-scoped repo bag used by the dual-write helpers. When a UnitOfWork is
   * driving the confirm (inside `runInTransaction`), `repos` is the tx-scoped
   * bag; otherwise the helpers fall back to the standalone constructor repos.
   */
  private bag(repos?: TransactionalRepos): {
    suggestions: InventorySuggestionRepository;
    inventory: ContractInventoryRepository;
    locations?: StockLocationRepository;
    assets?: InventoryAssetRepository;
    movements?: InventoryMovementRepository;
    resolveClientLocation?: ResolveClientLocation;
  } {
    if (repos) {
      return {
        suggestions: repos.suggestions,
        inventory: repos.inventory,
        locations: repos.locations,
        assets: repos.assets,
        movements: repos.movements,
        resolveClientLocation: new ResolveClientLocation(repos.locations),
      };
    }
    return {
      suggestions: this.suggestions,
      inventory: this.inventory,
      locations: this.locations,
      assets: this.assets,
      movements: this.movements,
      resolveClientLocation: this.resolveClientLocation,
    };
  }

  /**
   * Dual-write side of a DEVICE confirm: resolve the contract's CLIENTE location,
   * create the unified InventoryAsset (status=installed, idempotent by serialNumber),
   * and record the INSTALL movement. Returns the asset id to stamp onto the CII,
   * or null when dual-write is not wired.
   *
   * Fix #2: serial reuse is now SCOPED — an existing asset is reused only when it
   * is `available` OR already installed at THIS contract's CLIENTE location. An
   * asset `installed` somewhere else throws AssetInstalledElsewhereError instead
   * of being silently relocated onto this contract.
   *
   * Fix #5: the deviceType NAME must resolve to a catalog id (or OTROS). If
   * neither resolves we throw UnresolvableDeviceTypeError rather than writing the
   * raw NAME into the deviceTypeId FK column.
   */
  private async dualWriteAsset(
    b: ReturnType<ConfirmInventorySuggestion['bag']>,
    args: {
      contractId: string;
      type: string;
      serialNumber: string | null;
      mac: string | null;
      source: string;
      sourceTaskId: string | null;
      taskId: string;
      technicianId: string | null;
    },
  ): Promise<string | null> {
    // Design Decisión 2: delegate to the shared InstallContractAsset service. The
    // tx-scoped bag already exposes resolveClientLocation/assets/movements, which is
    // exactly the InstallBag shape. Behavior is identical to the previous inline impl.
    return this.install.installNew(b, args);
  }

  /**
   * Retire a replaced item's asset (Fix #3): route it through the validated
   * asset state machine (`nextStatus`) so an illegal transition throws inside the
   * transaction and rolls the whole replace() back. installed → removed is legal.
   */
  private async markAssetRemoved(
    b: ReturnType<ConfirmInventorySuggestion['bag']>,
    assetId: string | null,
  ): Promise<void> {
    if (!assetId || !b.assets) return;
    const asset = await b.assets.findById(assetId);
    if (!asset) return;
    const to = nextStatus(asset.status, 'removed'); // throws on illegal transition
    await b.assets.updateStatus(assetId, to);
  }

  /**
   * Mapea el source de la sugerencia al source que corresponde en ContractInstalledItem.
   * OCR → 'OCR', MANUAL → 'MANUAL', cualquier otro (ICLASS_MATERIAL) → 'ICLASS'.
   */
  private toItemSource(source: string): string {
    return source === 'OCR' || source === 'MANUAL' ? source : 'ICLASS';
  }

  async execute(input: ConfirmInventorySuggestionInput): Promise<ConfirmResult> {
    const suggestion = await this.suggestions.get(input.suggestionId);
    if (!suggestion) throw new SuggestionNotFoundError(input.suggestionId);
    if (suggestion.status === 'confirmed') throw new SuggestionAlreadyConfirmedError(input.suggestionId);
    assertSuggestionComplete(suggestion);

    const task = await this.scheduling.getTask(suggestion.taskId);
    const contractId = task?.contractId ?? null;
    if (!contractId) throw new TaskHasNoContractError(suggestion.taskId);

    const now = new Date().toISOString();

    if (suggestion.kind === 'MATERIAL') {
      return this.handleMaterial(suggestion, now, input.addedByUserId ?? null);
    }

    // ── DEVICE branch ─────────────────────────────────────────────────────────
    const resolution = input.resolution ?? 'add';

    // 'replace' is a destructive operation handled by the dedicated replace() method.
    // The route schema prevents it from reaching here, but guard defensively.
    if (resolution === 'replace') {
      throw new Error('Use the replace() method for replace resolution');
    }

    const activeItems = (await this.inventory.listByContract(contractId)).filter(
      (i) => i.status === 'active',
    );
    const match = matchInstalledItem(suggestion, activeItems);

    // same_device: the physical identity is already installed
    if (match.status === 'same_device') {
      if (resolution === 'add') {
        throw new DuplicateInstalledItemError(suggestion.id, match.item!.id);
      }
      // resolution === 'link_existing': link suggestion to the existing item, no creation
      await this.suggestions.setStatus(suggestion.id, 'confirmed', match.item!.id);
      const user = input.addedByUserId ? await this.users.findById(input.addedByUserId) : null;
      return { kind: 'DEVICE', item: toInstalledItemDto(match.item!, user?.name ?? null) };
    }

    // resolution 'link_existing' only makes sense for same_device (same physical identity).
    // If we reach here, no same_device match was found — treat as add.
    // (FE never sends link_existing without same_device, but handle gracefully.)

    // resolution === 'add' with same_type or no match → create (existing behavior, unchanged)
    const valid = new Set(await this.catalog.listActiveNames());
    const toType = (t: string | null): string =>
      t && valid.has(t.toUpperCase()) ? t.toUpperCase() : 'OTROS';

    const effectiveType = toType(input.typeOverride ?? suggestion.deviceType);
    const itemSource = this.toItemSource(suggestion.source);
    // When the operator picked a type in the dropdown, persist it onto the
    // suggestion too, so the resolved card shows what was confirmed (ANTENA),
    // not the original scan (ONU). Without an override the scan value stays.
    const persistedType = input.typeOverride != null ? effectiveType : undefined;

    // Fix #1: asset + INSTALL movement + CII + setStatus run in ONE transaction.
    const item = await this.runUnit(async (b) => {
      const assetId = await this.dualWriteAsset(b, {
        contractId,
        type: effectiveType,
        serialNumber: suggestion.serialNumber,
        mac: suggestion.mac,
        source: itemSource,
        sourceTaskId: suggestion.taskId,
        taskId: suggestion.taskId,
        technicianId: input.addedByUserId ?? null,
      });
      const created = await b.inventory.create({
        id: randomUUID(),
        contractId,
        type: effectiveType,
        serialNumber: suggestion.serialNumber,
        mac: suggestion.mac,
        model: null,
        source: itemSource,
        sourceTaskId: suggestion.taskId,
        addedByUserId: input.addedByUserId ?? null,
        confirmedAt: now,
        status: 'active',
        notes: null,
        replacesItemId: null, // add never replaces
        assetId,
        createdAt: now,
        updatedAt: now,
      });
      await b.suggestions.setStatus(suggestion.id, 'confirmed', created.id, persistedType);
      return created;
    });

    const user = input.addedByUserId ? await this.users.findById(input.addedByUserId) : null;
    return { kind: 'DEVICE', item: toInstalledItemDto(item, user?.name ?? null) };
  }

  /**
   * Runs `fn` inside the UnitOfWork transaction when one is wired (Fix #1/#3),
   * passing a tx-scoped repo bag; otherwise runs it against the standalone repos.
   * Either way `fn` only touches repos via the bag, so the same code path is
   * atomic in prod and rolls back cleanly in the in-memory adapter.
   */
  private async runUnit<T>(
    fn: (b: ReturnType<ConfirmInventorySuggestion['bag']>) => Promise<T>,
  ): Promise<T> {
    if (this.uow) {
      return this.uow.runInTransaction((repos) => fn(this.bag(repos)));
    }
    return fn(this.bag());
  }

  /**
   * Replace the same-type active item with a new one from this suggestion.
   * Requires a same_type match (not same_device — use link_existing for that).
   * Atomicity: retire first (update → replaced), then create. If create fails,
   * a replaced item without a successor is the tolerable state (never two active duplicates).
   */
  async replace(input: {
    suggestionId: string;
    addedByUserId?: string | null;
    typeOverride?: string | null;
  }): Promise<ConfirmResult> {
    const suggestion = await this.suggestions.get(input.suggestionId);
    if (!suggestion) throw new SuggestionNotFoundError(input.suggestionId);
    if (suggestion.status === 'confirmed') throw new SuggestionAlreadyConfirmedError(input.suggestionId);
    if (suggestion.kind !== 'DEVICE') throw new NotADeviceError(input.suggestionId);
    assertSuggestionComplete(suggestion);

    const task = await this.scheduling.getTask(suggestion.taskId);
    const contractId = task?.contractId ?? null;
    if (!contractId) throw new TaskHasNoContractError(suggestion.taskId);

    const activeItems = (await this.inventory.listByContract(contractId)).filter(
      (i) => i.status === 'active',
    );
    const match = matchInstalledItem(suggestion, activeItems);

    // replace requires a same_type target (not same_device — that path uses link_existing)
    if (match.status !== 'same_type') {
      throw new NoReplaceTargetError(input.suggestionId);
    }

    const now = new Date().toISOString();

    const valid = new Set(await this.catalog.listActiveNames());
    const toType = (t: string | null): string =>
      t && valid.has(t.toUpperCase()) ? t.toUpperCase() : 'OTROS';

    const effectiveType = toType(input.typeOverride ?? suggestion.deviceType);
    const itemSource = this.toItemSource(suggestion.source);
    const persistedType = input.typeOverride != null ? effectiveType : undefined;

    // Fix #1/#3: retire old (validated transition) + new asset + INSTALL movement
    // + new CII + setStatus all run in ONE transaction. A mid-replace failure
    // (e.g. illegal asset transition, failing INSTALL movement) rolls everything
    // back — the old item is NOT left replaced with no successor.
    const item = await this.runUnit(async (b) => {
      // 1) Retire the old item
      await b.inventory.update(match.item!.id, { status: 'replaced' });
      // Fix #3: mark the retired item's asset `removed` via the validated state
      // machine (illegal transition throws → rollback).
      await this.markAssetRemoved(b, match.item!.assetId);

      // 2) Create the new item, linked to the retired one
      const assetId = await this.dualWriteAsset(b, {
        contractId,
        type: effectiveType,
        serialNumber: suggestion.serialNumber,
        mac: suggestion.mac,
        source: itemSource,
        sourceTaskId: suggestion.taskId,
        taskId: suggestion.taskId,
        technicianId: input.addedByUserId ?? null,
      });
      const created = await b.inventory.create({
        id: randomUUID(),
        contractId,
        type: effectiveType,
        serialNumber: suggestion.serialNumber,
        mac: suggestion.mac,
        model: null,
        source: itemSource,
        sourceTaskId: suggestion.taskId,
        addedByUserId: input.addedByUserId ?? null,
        confirmedAt: now,
        status: 'active',
        notes: null,
        replacesItemId: match.item!.id, // link to the retired item
        assetId,
        createdAt: now,
        updatedAt: now,
      });
      await b.suggestions.setStatus(suggestion.id, 'confirmed', created.id, persistedType);
      return created;
    });

    const user = input.addedByUserId ? await this.users.findById(input.addedByUserId) : null;
    return { kind: 'DEVICE', item: toInstalledItemDto(item, user?.name ?? null) };
  }

  private async handleMaterial(
    suggestion: TaskInventorySuggestion,
    now: string,
    addedByUserId: string | null,
  ): Promise<ConfirmResult> {
    // Resolve material by canonical UPPERCASE name (create-if-missing, fallback OTRO)
    const desc = (suggestion.materialDesc ?? '').trim();
    const canonical = desc.toUpperCase();
    let material = desc ? await this.materials.getByName(canonical) : null;
    if (!material && desc) {
      material = await this.materials.create({ name: canonical, unit: suggestion.unit ?? null });
    }
    if (!material) {
      material = await this.materials.getByName('OTRO');
    }

    // material is guaranteed non-null now (OTRO must exist in the catalog)
    const mat = material!;

    const consumption = await this.consumptions.create({
      id: randomUUID(),
      taskId: suggestion.taskId,
      materialCatalogId: mat.id,
      // snapshot: preserve original IClass text, not the canonical name
      materialName: desc || mat.name,
      quantity: suggestion.quantity ?? 1,
      unit: suggestion.unit ?? mat.unit,
      notes: null,
      recordedByUserId: addedByUserId,
      deductedAt: null,
      deductedMovementId: null,
      createdAt: now,
      updatedAt: now,
    });

    await this.suggestions.setStatus(suggestion.id, 'confirmed', consumption.id);

    // EPIC #38 W6 — best-effort stage hook (mirrors W4 side-effect pattern).
    // Staging failures MUST NOT abort this confirm — swallow silently.
    if (this.stageMaterialDeduction) {
      try {
        const task = await this.scheduling.getTask(suggestion.taskId);
        await this.stageMaterialDeduction.execute({
          consumptionId: consumption.id,
          taskId: consumption.taskId,
          technicianId: task?.assigneeId ?? null,
          materialCatalogId: mat.id,
          qty: suggestion.quantity ?? 1,
        });
      } catch {
        // best-effort — never propagate
      }
    }

    const user = addedByUserId ? await this.users.findById(addedByUserId) : null;
    return { kind: 'MATERIAL', consumption: toMaterialConsumptionDto(consumption, user?.name ?? null) };
  }
}
