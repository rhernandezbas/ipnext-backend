/**
 * TDD: RetireContractEquipment use case (#39)
 * Scenarios: RET-1..9, DEP-1/2 from design.md
 */
import { RetireContractEquipment } from '@application/use-cases/RetireContractEquipment';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryUnitOfWork } from '@infrastructure/adapters/in-memory/InMemoryUnitOfWork';
import { createInventoryAsset } from '@domain/entities/inventory-asset';
import {
  TaskHasNoContractError,
  ProjectNotRetirementError,
  EquipmentNotOnContractError,
  RetireAlreadyDoneError,
} from '@domain/errors/inventory';
import { DomainError } from '@domain/errors/index';
import { randomUUID } from 'crypto';

const TASK_ID = 'task-retire-1';
const CONTRACT_ID = 'contract-retire-1';
const OTHER_CONTRACT_ID = 'contract-other-2';
const PROJECT_ID = 'proj-retire-1';

async function setup(opts?: {
  allowsRetirement?: boolean;
  withContract?: boolean;
  withProject?: boolean;
}) {
  const allowsRetirement = opts?.allowsRetirement ?? true;
  const withContract = opts?.withContract ?? true;
  const withProject = opts?.withProject ?? true;

  const schedulingRepo = new InMemorySchedulingRepository();
  const contractInvRepo = new InMemoryContractInventoryRepository();
  const assetRepo = new InMemoryInventoryAssetRepository();
  const materialStockRepo = new InMemoryMaterialStockRepository();
  const movementRepo = new InMemoryInventoryMovementRepository(assetRepo, materialStockRepo);
  const locationRepo = new InMemoryStockLocationRepository();
  const suggestionsRepo = new InMemoryInventorySuggestionRepository();

  const uow = new InMemoryUnitOfWork(
    suggestionsRepo,
    contractInvRepo,
    locationRepo,
    assetRepo,
    movementRepo,
    materialStockRepo,
  );

  const resolveDepot = new ResolveDepotLocation(locationRepo);

  // Ensure DEPOSITO exists upfront (ResolveDepotLocation creates it on first call)
  await resolveDepot.execute('DEPOSITO');

  // Seed a task using the public seedTask helper
  schedulingRepo.seedTask({
    id: TASK_ID,
    projectId: withProject ? PROJECT_ID : null,
    projectName: withProject ? 'Test Project' : null,
    projectAllowsRetirement: withProject ? allowsRetirement : false,
    contractId: withContract ? CONTRACT_ID : null,
  });

  const useCase = new RetireContractEquipment(
    schedulingRepo,
    contractInvRepo,
    assetRepo,
    movementRepo,
    resolveDepot,
    uow,
  );

  return { schedulingRepo, contractInvRepo, assetRepo, movementRepo, locationRepo, uow, useCase };
}

function seedCII(
  repo: InMemoryContractInventoryRepository,
  contractId: string,
  assetId: string | null = null,
  status: 'active' | 'removed' | 'replaced' = 'active',
): string {
  const id = `cii-${randomUUID().slice(0, 8)}`;
  repo.store.set(id, {
    id,
    contractId,
    type: 'ONU',
    serialNumber: assetId ? `SN-${assetId.slice(0, 6)}` : null,
    mac: null,
    model: null,
    source: 'MANUAL',
    sourceTaskId: null,
    addedByUserId: null,
    confirmedAt: null,
    status,
    notes: null,
    replacesItemId: null,
    assetId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return id;
}

function seedAsset(
  assetRepo: InMemoryInventoryAssetRepository,
  locationId: string,
  status: 'installed' | 'available' = 'installed',
): string {
  const id = `asset-${randomUUID().slice(0, 8)}`;
  assetRepo.store.set(id, createInventoryAsset({
    id,
    serialNumber: `SN-${id}`,
    mac: null,
    deviceTypeId: 'dt-onu',
    status,
    currentLocationId: locationId,
    source: 'MANUAL',
    sourceTaskId: null,
  }));
  return id;
}

describe('RetireContractEquipment', () => {
  // SCEN-RET-7: task has no contractId → 422 TASK_HAS_NO_CONTRACT
  it('SCEN-RET-7: task without contractId → TaskHasNoContractError', async () => {
    const { useCase } = await setup({ withContract: false });
    await expect(
      useCase.execute({ taskId: TASK_ID, itemIds: ['cii-1'], actorId: null }),
    ).rejects.toBeInstanceOf(TaskHasNoContractError);
  });

  // SCEN-RET-6: project.allowsEquipmentRetirement = false → 422 PROJECT_NOT_RETIREMENT
  it('SCEN-RET-6: project does not allow retirement → ProjectNotRetirementError', async () => {
    const { useCase } = await setup({ allowsRetirement: false });
    await expect(
      useCase.execute({ taskId: TASK_ID, itemIds: ['cii-1'], actorId: null }),
    ).rejects.toBeInstanceOf(ProjectNotRetirementError);
  });

  // SCEN-RET-4: CII from another contract → 422 EQUIPMENT_NOT_ON_CONTRACT
  it('SCEN-RET-4: CII belongs to a different contract → EquipmentNotOnContractError', async () => {
    const { useCase, contractInvRepo, assetRepo, locationRepo } = await setup();
    const depot = await locationRepo.findByCode('DEPOSITO');
    const assetId = seedAsset(assetRepo, depot!.id);
    // seed CII on ANOTHER contract
    const otherId = seedCII(contractInvRepo, OTHER_CONTRACT_ID, assetId);

    await expect(
      useCase.execute({ taskId: TASK_ID, itemIds: [otherId], actorId: null }),
    ).rejects.toBeInstanceOf(EquipmentNotOnContractError);
  });

  // SCEN-RET-4 triangulate: CII does not exist at all → EquipmentNotOnContractError
  it('SCEN-RET-4 (tri): non-existent CII id → EquipmentNotOnContractError', async () => {
    const { useCase } = await setup();
    await expect(
      useCase.execute({ taskId: TASK_ID, itemIds: ['non-existent-cii'], actorId: null }),
    ).rejects.toBeInstanceOf(EquipmentNotOnContractError);
  });

  // SCEN-RET-1: happy path CII+assetId → removed + RETURN movement
  it('SCEN-RET-1: happy path — CII with asset → removed + RETURN movement source=MANUAL', async () => {
    const { useCase, contractInvRepo, assetRepo, movementRepo, locationRepo } = await setup();

    const depot = await locationRepo.findByCode('DEPOSITO');
    const clientLocId = 'loc-client-1';
    locationRepo.store.set(clientLocId, { id: clientLocId, type: 'CLIENTE', contractId: CONTRACT_ID, technicianId: null, vehicleId: null, code: null });

    const assetId = seedAsset(assetRepo, clientLocId, 'installed');
    const ciiId = seedCII(contractInvRepo, CONTRACT_ID, assetId);

    const result = await useCase.execute({ taskId: TASK_ID, itemIds: [ciiId], actorId: null });

    // CII is removed
    expect(result.retired).toHaveLength(1);
    expect(result.retired[0].itemId).toBe(ciiId);
    expect(result.retired[0].status).toBe('removed');
    expect(result.retired[0].assetId).toBe(assetId);
    expect(result.retired[0].movementId).not.toBeNull();

    // Asset is available@depot
    const asset = await assetRepo.findById(assetId);
    expect(asset!.status).toBe('available');
    expect(asset!.currentLocationId).toBe(depot!.id);

    // Movement: RETURN, source=MANUAL, taskId, sourceRef
    const mv = movementRepo.movements.find(m => m.assetId === assetId);
    expect(mv).toBeDefined();
    expect(mv!.type).toBe('RETURN');
    expect(mv!.source).toBe('MANUAL');
    expect(mv!.taskId).toBe(TASK_ID);
    expect(mv!.sourceRef).toBe(`manual:retire:${TASK_ID}:${ciiId}`);
  });

  // SCEN-RET-3: legacy CII without assetId → CII removed, NO movement
  it('SCEN-RET-3: legacy CII without assetId → removed without movement', async () => {
    const { useCase, contractInvRepo, movementRepo } = await setup();
    const ciiId = seedCII(contractInvRepo, CONTRACT_ID, null); // no assetId

    const result = await useCase.execute({ taskId: TASK_ID, itemIds: [ciiId], actorId: null });

    expect(result.retired).toHaveLength(1);
    expect(result.retired[0].itemId).toBe(ciiId);
    expect(result.retired[0].status).toBe('removed');
    expect(result.retired[0].assetId).toBeNull();
    expect(result.retired[0].movementId).toBeNull();

    // No movement was created
    expect(movementRepo.movements).toHaveLength(0);
  });

  // SCEN-RET-5: re-retire same CII → 409 RETIRE_ALREADY_DONE
  it('SCEN-RET-5: re-retire same CII (pre-write findBySourceRef) → RetireAlreadyDoneError', async () => {
    const { useCase, contractInvRepo, assetRepo, locationRepo } = await setup();
    const clientLocId = 'loc-client-2';
    locationRepo.store.set(clientLocId, { id: clientLocId, type: 'CLIENTE', contractId: CONTRACT_ID, technicianId: null, vehicleId: null, code: null });

    const assetId = seedAsset(assetRepo, clientLocId, 'installed');
    const ciiId = seedCII(contractInvRepo, CONTRACT_ID, assetId);

    // First retire
    await useCase.execute({ taskId: TASK_ID, itemIds: [ciiId], actorId: null });

    // Re-seed CII as active again (simulate repeated request on same task+CII)
    contractInvRepo.store.set(ciiId, {
      ...(contractInvRepo.store.get(ciiId)!),
      status: 'active',
    });

    // Second retire → 409
    await expect(
      useCase.execute({ taskId: TASK_ID, itemIds: [ciiId], actorId: null }),
    ).rejects.toBeInstanceOf(RetireAlreadyDoneError);
  });

  // SCEN-RET-2: N items, one fails → rollback total
  it('SCEN-RET-2: partial failure → rollback (no CII removed, no movement)', async () => {
    const { useCase, contractInvRepo, assetRepo, locationRepo, movementRepo } = await setup();
    const clientLocId = 'loc-client-3';
    locationRepo.store.set(clientLocId, { id: clientLocId, type: 'CLIENTE', contractId: CONTRACT_ID, technicianId: null, vehicleId: null, code: null });

    const assetId = seedAsset(assetRepo, clientLocId, 'installed');
    const cii1 = seedCII(contractInvRepo, CONTRACT_ID, assetId);
    // cii2 on a DIFFERENT contract — will fail
    const cii2 = seedCII(contractInvRepo, OTHER_CONTRACT_ID, null);

    await expect(
      useCase.execute({ taskId: TASK_ID, itemIds: [cii1, cii2], actorId: null }),
    ).rejects.toBeInstanceOf(EquipmentNotOnContractError);

    // CII1 must still be active (rollback)
    const cii1After = await contractInvRepo.getById(cii1);
    expect(cii1After!.status).toBe('active');

    // No movements (rollback)
    expect(movementRepo.movements).toHaveLength(0);
  });

  // SCEN-RET-8: itemIds empty → error with code VALIDATION_ERROR
  it('SCEN-RET-8: empty itemIds → throws with code VALIDATION_ERROR', async () => {
    const { useCase } = await setup();
    await expect(
      useCase.execute({ taskId: TASK_ID, itemIds: [], actorId: null }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // FIX-6a: asset already available@depot → CII removed, NO additional RETURN movement
  it('FIX-6a: asset already available at depot (not installed) → CII removed, no double RETURN', async () => {
    // This covers the else-branch in RetireContractEquipment when asset.status !== 'installed'.
    // Ensures no double ledger entry is written when the asset is already back at depot.
    const { useCase, contractInvRepo, assetRepo, movementRepo, locationRepo } = await setup();

    // Asset is at DEPOSITO (available), not installed
    const depot = await locationRepo.findByCode('DEPOSITO');
    const assetId = seedAsset(assetRepo, depot!.id, 'available');
    const ciiId = seedCII(contractInvRepo, CONTRACT_ID, assetId);

    const result = await useCase.execute({ taskId: TASK_ID, itemIds: [ciiId], actorId: null });

    // CII is still retired (removed)
    expect(result.retired).toHaveLength(1);
    expect(result.retired[0].itemId).toBe(ciiId);
    expect(result.retired[0].status).toBe('removed');
    // assetId is present but no movement was written
    expect(result.retired[0].assetId).toBe(assetId);
    expect(result.retired[0].movementId).toBeNull();

    // No movement created (asset was already at depot — no double RETURN)
    expect(movementRepo.movements).toHaveLength(0);

    // Asset location unchanged (still at depot)
    const assetAfter = await assetRepo.findById(assetId);
    expect(assetAfter!.currentLocationId).toBe(depot!.id);
  });

  // SCEN-DEP-1/DEP-2: asset at depot, movement source=MANUAL with taskId
  it('SCEN-DEP-1/DEP-2: post-retire asset available@depot; movement source=MANUAL with taskId', async () => {
    const { useCase, contractInvRepo, assetRepo, movementRepo, locationRepo } = await setup();
    const clientLocId = 'loc-client-4';
    locationRepo.store.set(clientLocId, { id: clientLocId, type: 'CLIENTE', contractId: CONTRACT_ID, technicianId: null, vehicleId: null, code: null });

    const depot = await locationRepo.findByCode('DEPOSITO');
    const assetId = seedAsset(assetRepo, clientLocId, 'installed');
    const ciiId = seedCII(contractInvRepo, CONTRACT_ID, assetId);

    await useCase.execute({ taskId: TASK_ID, itemIds: [ciiId], actorId: null });

    // DEP-1: asset is available@DEPOSITO
    const asset = await assetRepo.findById(assetId);
    expect(asset!.status).toBe('available');
    expect(asset!.currentLocationId).toBe(depot!.id);

    // DEP-2: ledger row has source=MANUAL, taskId, toLocationId=DEPOSITO
    const mv = movementRepo.movements.find(m => m.assetId === assetId);
    expect(mv!.source).toBe('MANUAL');
    expect(mv!.taskId).toBe(TASK_ID);
    expect(mv!.toLocationId).toBe(depot!.id);
    expect(mv!.type).toBe('RETURN');
  });
});
